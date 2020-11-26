import { _, lazy_require, path, fsAsync } from 'azk';
import { publish } from 'azk/utils/postal';
import { async, originalDefer } from 'azk/utils/promises';
import { DockerBuildError } from 'azk/utils/errors';

var lazy = lazy_require({
  JStream : 'jstream',
  XRegExp : ['xregexp', 'XRegExp'],
  archiver: 'archiver',
});

var msg_regex = {
  get building_from      () { return new lazy.XRegExp('FROM (?<FROM>.*)'); },
  get building_maintainer() { return new lazy.XRegExp('MAINTAINER (?<MAINTAINER>.*)'); },
  get building_run       () { return new lazy.XRegExp('RUN (.*)'); },
  get building_cmd       () { return new lazy.XRegExp('CMD (.*)'); },
  get building_complete  () { return new lazy.XRegExp('Successfully built (?<IMAGE_ID>.*)'); },
};

function parse_stream(msg) {
  var result = {};
  _.find(msg_regex, (regex, type) => {
    var match  = lazy.XRegExp.exec(msg, regex);

    if (match) {
      result.type = type;
      result.command = match[0];
      result.value = match[1];
      result.input = match.input;

      _.each(regex.xregexp.captureNames, function(key) {
        if (match[key]) {
          result[key] = match[key];
        }
      });
      return true;
    }
  });
  return result;
}

export function build(docker, options) {
  return async(function* () {
    var opts = _.extend({
      cache: true
    }, options);

    // Check if "Dockerfile" exist
    var dockerfile = opts.dockerfile;
    if (!(yield fsAsync.exists(dockerfile))) {
      throw new DockerBuildError('cannot_find_dockerfile', { dockerfile });
    }

    if (_.isEmpty(opts.tag)) {
      throw Error("Not build a image with a empty tag");
    }

    // Create a tar and includes Dockerfile
    var archive = lazy.archiver('tar');
    var src     = ["**", ".*", "**/.*", "!Dockerfile"];
    var cwd     = path.dirname(dockerfile);

    // Filter with .dockerignore
    var ignore  = path.join(cwd, '.dockerignore');
    var exists_ignore = yield fsAsync.exists(ignore);
    if (exists_ignore) {
      var ignore_content = yield fsAsync.readFile(ignore);
      ignore_content = ignore_content.toString()
        .trim()
        .split('\n')
        .map((entry) => {
          entry = entry.trim();
          return (_.isEmpty(entry) || entry.startsWith('#')) ? null : `!${entry}`;
        })
        .filter((entry) => entry);
      src = _.uniq(src.concat(ignore_content));
    }

    // Add files
    archive.bulk([{ expand: true, cwd, src, dest: '/' }]);
    archive.file(dockerfile, { name: 'Dockerfile' });
    if (exists_ignore) {
      archive.file(ignore, { name: '.dockerignore' });
    }
    archive.finalize();

    // Options and defer
    var done = originalDefer();
    var build_options = { t: opts.tag, forcerm: true, nocache: !opts.cache, q: !opts.verbose };

    if (!_.isEmpty(opts.target)) {
      build_options.target = opts.target;
    }

    // Start stream
    var stream = yield docker.buildImage(archive, build_options).catch((err) => {
      throw new DockerBuildError('server_error', { dockerfile, err });
    });
    stream.on('end', () => done.resolve(docker.findImage(opts.tag)));

    // Parse json stream
    var from = null;
    var output = '';
    let downloading_status_counter = 0;
    stream.pipe(new lazy.JStream()).on('data', (msg) => {
      if (!msg.error) {
        msg.type = 'build_msg';
        msg.statusParsed = parse_stream(msg.stream);
        let has_status = typeof msg.statusParsed.type !== 'undefined';

        // verbose: standard output
        if (opts.verbose && opts.stdout && has_status) {
          opts.stdout.write('  ' + msg.stream);
        }

        // verbose: simple downloading bar from docker API
        // we check for clearLine since stdout is not always a terminal
        if (opts.verbose && opts.stdout && opts.stdout.clearLine && msg.status === 'Downloading') {
          if (downloading_status_counter > 0) {
            opts.stdout.clearLine();
            opts.stdout.moveCursor(0, -1);
          }
          downloading_status_counter++;
          opts.stdout.clearLine();
          opts.stdout.cursorTo(0);
          opts.stdout.write(`- [${msg.id}] ${msg.progress}\n`);
        }

        if (has_status) {
          publish("docker.build.status", msg);
          if (msg.statusParsed.type == "building_from") {
            from = msg.statusParsed.FROM;
          }
        }
        output += msg.stream;
      } else {
        output += msg.error;

        var capture = null;
        var check_and_capture = (regex) => {
          capture = msg.error.match(regex);
          return capture;
        };

        var reject = (key, opts = {}) => {
          var options = _.merge({ dockerfile, from, output }, opts);
          done.reject(new DockerBuildError(key, options));
        };

        if (msg.error.match(/image .* not found/)) {
          reject('not_found');
        } else if (msg.error.match(/returned a non-zero code/)) {
          output = output.replace(/^(.*)/gm, '    $1');
          reject('command_error', { output });
        } else if (check_and_capture(/Unknown instruction: (.*)/)) {
          reject('unknow_instrction_error', { instruction: capture[1] });
        } else {
          output = output.replace(/^(.*)/gm, '    $1');
          reject('unexpected_error', { output });
        }
      }
    });
    return done.promise;
  });
}

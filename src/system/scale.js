import { Q, async, _, lazy_require } from 'azk';
import { calculateHash } from 'azk/utils';
import { SystemDependError, SystemNotScalable } from 'azk/utils/errors';
import { Balancer } from 'azk/system/balancer';
import { Tracker } from 'azk/utils/tracker';

/* global docker */
lazy_require(this, {
  docker: ['azk/docker', 'default'],
});

var Scale = {
  start(system, options = {}) {
    // Scale to default instances
    return this.scale(system, options);
  },

  scale(system, instances = {}, options = {}) {
    // Default instances
    if (_.isObject(instances)) {
      options   = _.merge(instances, options);
      instances = system.scalable.default;
    }

    // Default options
    options = _.defaults(options, {
      envs: {},
      dependencies: true,
    });

    return async(this, function* (notify) {
      // how many times the
      var containers = yield this.instances(system);

      // how to add or remove
      var from = containers.length;
      var icc  = instances - from;

      // Protect not scalable systems
      var limit = system.scalable.limit;
      if (limit > 0 && icc > 0 && (from + icc > limit)) {
        return Q.reject(new SystemNotScalable(system));
      }

      if (icc !== 0) {
        notify({ type: "scale", from: from, to: from + icc, system: system.name });
      }

      if (icc > 0) {
        var deps_envs = yield this.checkDependsAndReturnEnvs(system, options);
        options.envs  = _.merge(deps_envs, options.envs || {});

        for (var i = 0; i < icc; i++) {
          yield system.runDaemon(_.clone(options));
          options.provision_force = false;
        }
      } else if (icc < 0) {
        containers = containers.reverse().slice(0, Math.abs(icc));
        yield system.stop(containers, options);
      }

      var to = from + icc;

      // Tracker
      yield this._track('scale', system, from, to);

      return icc;
    });
  },

  //
  // Tracker
  //
  _track(event_type_name, system, from, to) {
    return async(this, function* () {
      var tracker = new Tracker();

      var manifest_id = system.manifest.namespace;

      // get event_type
      tracker.addData({
        event_type: event_type_name,
        manifest_id: manifest_id,
        from_num_containers: from,
        to_num_containers: to,
        hash_system: calculateHash(manifest_id + system.name).slice(0, 8),
      });

      // rescue session id
      tracker.meta_info = {
        agent_session_id: tracker.loadAgentSessionId(),
        command_id      : tracker.loadCommandId(),
      };

      // track
      var tracker_result = yield tracker.track('system', tracker.data);
      if (tracker_result !== 0) {
        console.log('ERROR tracker_result:', tracker_result);
      }
    });
  },

  killAll(system, options = {}) {
    return async(this, function* () {
      options = _.defaults(options, {
        kill: true,
      });

      // Clear balancer
      yield Balancer.clear(system);

      var instances = yield this.instances(system);
      return system.stop(instances, options.kill);
    });
  },

  _dependencies_options(options) {
    return {
      dependencies: options.dependencies,
      pull: options.pull,
    };
  },

  checkDependsAndReturnEnvs(system, options, required = true) {
    var depends = system.dependsInstances;
    return async(this, function* () {
      var instances, depend, scale_to, envs = {};

      for (var d = 0; d < depends.length; d++) {
        depend    = depends[d];
        instances = yield this.instances(depend);
        if (_.isEmpty(instances) && required) {
          // Run dependencies
          if (options.dependencies) {
            scale_to = depend.scalable.default;
            yield depend.scale(scale_to > 0 ? scale_to : 1, this._dependencies_options(options));
            instances = yield this.instances(depend);
          } else {
            throw new SystemDependError(system.name, depend.name);
          }
        }

        if (!_.isEmpty(instances)) {
          envs = _.merge(envs, yield this.getEnvs(depend, instances));
        }
      }

      return envs;
    });
  },

  getEnvs(system, instances = null) {
    return async(this, function* () {
      var ports = {}, envs = {};
      if (instances.length > 0) {
        var data = yield docker.getContainer(instances[0].Id).inspect();
        _.each(data.NetworkSettings.Access, (port) => {
          ports[port.name] = port.port;
        });
        envs = system.expandExportEnvs({
          envs: this._parseEnvs(data.Config.Env),
          net: { port: ports }
        });
      }
      return envs;
    });
  },

  _parseEnvs(collection) {
    return _.reduce(collection, (envs, env) => {
      if (env.match(/\=/)) {
        env = env.split("=");
        envs[env[0]] = env[1];
      }
      return envs;
    }, {});
  },

  instances(system, options = {}) {
    return system.instances(_.defaults(options, {
      type: "daemon",
    }));
  },
};

export { Scale };

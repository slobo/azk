/**
 * Documentation: http://docs.azk.io/Azkfile.js
 */

// Adds the systems that shape your system
systems({
  'docs-azk': {
    image: { docker: "node:0.10" },

    // Steps to execute before running instances
    provision: [
      "npm i",
      "node node_modules/.bin/gitbook install content",
    ],
    workdir: "/azk/#{manifest.dir}",
    shell: "/bin/bash",
    command: "node_modules/.bin/gitbook serve --port $HTTP_PORT content",
    wait: {"retry": 20, "timeout": 2000},
    mounts: {
      '/azk/#{manifest.dir}': path("."),
      '/azk/node_modules': persistent("node_modules"),
    },
    scalable: {"default": 1},
    http: {
      // docs-azk.
      domains: [ "#{system.name}.#{azk.default_domain}" ]
    },
    ports: {
      livereload: "35729:35729/tcp",
    },
  },
});




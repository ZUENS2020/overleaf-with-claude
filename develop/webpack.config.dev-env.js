const { merge } = require('webpack-merge')

const base = require('./webpack.config.dev')

module.exports = merge(base, {
  devServer: {
    allowedHosts: 'auto',
    devMiddleware: {
      index: false,
    },
    proxy: [
      {
        context: '/socket.io/**',
        target: 'http://real-time:3026',
        ws: true,
      },
      {
        // AI session proxy: forwards to code-server through web. Has to be
        // matched BEFORE the .js/.css/.json exclusion below — otherwise
        // webpack-dev-server eats code-server's static asset requests and
        // returns 404, leaving the iframe blank.
        //
        // Use a function context instead of a glob: VS Code's WebSocket
        // reconnection URL includes a query string
        // (?reconnectionToken=xxx&...) and webpack-dev-server passes the
        // full URL (path + query) to the glob matcher, so '/ai/session/**'
        // fails to match and the proxy target resolves to undefined →
        // ECONNREFUSED. A function check on pathname avoids this.
        context: pathname => pathname.startsWith('/ai/session/'),
        target: 'http://web:3000',
        ws: true,
      },
      {
        context: ['!**/*.js', '!**/*.css', '!**/*.json'],
        target: 'http://web:3000',
      },
    ],
  },
})

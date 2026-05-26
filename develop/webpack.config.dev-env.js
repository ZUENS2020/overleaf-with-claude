const { merge } = require('webpack-merge')
const net = require('net')

const base = require('./webpack.config.dev')

module.exports = merge(base, {
  devServer: {
    // VS Code's WebSocket reconnection URLs include query strings
    // (?reconnectionToken=xxx&...). webpack-dev-server passes the full
    // URL (path + query) to the glob matcher AND to function contexts for
    // WS upgrades, but http-proxy-middleware registers WS upgrade handlers
    // statically at startup time using the raw target — when the target is
    // a function it resolves to undefined and the upgrade fails with
    // ECONNREFUSED. The only reliable fix is to intercept the raw
    // 'upgrade' event ourselves before http-proxy-middleware sees it.
    onListening(devServer) {
      devServer.server.on('upgrade', (req, socket, head) => {
        if (!req.url || !req.url.startsWith('/ai/session/')) return
        // Mark socket as handled so http-proxy-middleware doesn't also
        // try to proxy it (which would fail and destroy the socket).
        socket._aiSessionHandled = true
        const upstream = net.connect(3000, 'web', () => {
          // Re-emit the HTTP/1.1 upgrade request the browser sent us.
          const headerLines = Object.entries(req.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n')
          upstream.write(
            `${req.method} ${req.url} HTTP/1.1\r\n${headerLines}\r\n\r\n`
          )
          if (head && head.length) upstream.write(head)
          upstream.pipe(socket)
          socket.pipe(upstream)
        })
        upstream.on('error', () => socket.destroy())
        socket.on('error', () => upstream.destroy())
      })
    },
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
        // HTTP asset requests for /ai/session/** (JS, CSS, fonts, etc.).
        // WS upgrades on this path are handled by onListening above so
        // we set ws: false here to prevent double-handling.
        context: pathname => pathname.startsWith('/ai/session/'),
        target: 'http://web:3000',
        ws: false,
      },
      {
        context: ['!**/*.js', '!**/*.css', '!**/*.json'],
        target: 'http://web:3000',
      },
    ],
  },
})

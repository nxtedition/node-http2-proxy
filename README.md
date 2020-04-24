# http2-proxy

A simple http/2 & http/1.1 spec compliant proxy helper for Node.

## Features

- Proxies HTTP 2, HTTP 1 and WebSocket.
- Simple and high performance.
- [Hop by hop header handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers).
- [Connection header handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Connection).
- [Via header handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Via).
- [Forward header handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Forward).

## Installation

```bash
$ npm install http2-proxy
```

## Notes

`http2-proxy` requires at least node **v10.0.0**.

Fully async/await compatible and all callback based usage is optional and discouraged.

During 503 it is safe to assume that nothing was read or written. This makes it safe to retry request (including non idempotent methods).

Use a final and/or error handler since errored responses won't be cleaned up automatically. This makes it possible to perform retries.

```js
const finalhandler = require('finalhandler')

const defaultWebHandler = (err, req, res) => {
  if (err) {
    console.error('proxy error', err)
    finalhandler(req, res)(err)
  }
}

const defaultWSHandler = (err, req, socket, head) => {
  if (err) {
    console.error('proxy error', err)
    socket.destroy()
  }
}
```

## HTTP/1 API

You must pass `allowHTTP1: true` to the `http2.createServer` or `http2.createSecureServer` factory methods.

```js
import http2 from 'http2'
import proxy from 'http2-proxy'

const server = http2.createServer({ allowHTTP1: true })
server.listen(8000)
```

You can also use `http-proxy2` with the old `http` && `https` API's.

```js
import http from 'http'

const server = http.createServer()
server.listen(8000)
```

## API

### Proxy HTTP/2, HTTP/1 and WebSocket

```js
server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000
  }, defaultWebHandler)
})
server.on('upgrade', (req, socket, head) => {
  proxy.ws(req, socket, head, {
    hostname: 'localhost'
    port: 9000
  }, defaultWsHandler)
})
```

### Use [Connect](https://www.npmjs.com/package/connect) & [Helmet](https://www.npmjs.com/package/helmet)

```js
const app = connect()
app.use(helmet())
app.use((req, res, next) => proxy
  .web(req, res, {
    hostname: 'localhost'
    port: 9000
  }, err => {
    if (err) {
      next(err)
    }
  })
)
server.on('request', app)
```

### Add x-forwarded Headers

```js
server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000,
    onReq: (req, { headers }) => {
      headers['x-forwarded-for'] = req.socket.remoteAddress
      headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http'
      headers['x-forwarded-host'] = req.headers['host']
    }
  }, defaultWebHandler)
})
```

### Follow Redirects

```js
const http = require('follow-redirects').http

server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000,
    onReq: (req, options) => http.request(options)
  }, defaultWebHandler)
})
```

### Add Response Header

```js
server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000,
    onReq: (req, options) => http.request(options),
    onRes: (req, res, proxyRes) => {
      res.setHeader('x-powered-by', 'http2-proxy')
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    }
  }, defaultWebHandler)
})
```

### Proxy HTTP2

HTTP proxying can be achieved using http2 client compat
libraries such as:

https://github.com/hisco/http2-client
https://github.com/spdy-http2/node-spdy
https://github.com/grantila/fetch-h2
https://github.com/szmarczak/http2-wrapper

```js
const http = require('http2-wrapper')

server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000,
    onReq: (req, options) => http.request(options)
  }, defaultWebHandler)
})
```

### Try Multiple Upstream Servers (Advanced)

```js
const http = require('http')
const proxy = require('http2-proxy')
const createError = require('http-errors')

server.on('request', async (req, res) => {
  try {
    res.statusCode = null
    for await (const { port, timeout, hostname } of upstream) {
      if (req.aborted || res.readableEnded) {
        return
      }

      let error = null
      let bytesWritten = 0
      try {
        return await proxy.web(req, res, {
          port,
          timeout,
          hostname,
          onRes: async (req, res, proxyRes) => {
            if (proxyRes.statusCode >= 500) {
              throw createError(proxyRes.statusCode, proxyRes.message)
            }

            function setHeaders () {
              if (!bytesWritten) {
                res.statusCode = proxyRes.statusCode
                for (const [ key, value ] of Object.entries(headers)) {
                  res.setHeader(key, value)
                }
              }
            }

            // NOTE: At some point this will be possible
            // proxyRes.pipe(res)

            proxyRes
              .on('data', buf => {
                setHeaders()
                bytesWritten += buf.length
                if (!res.write(buf)) {
                  proxyRes.pause()
                }
              })
              .on('end', () => {
                setHeaders()
                res.addTrailers(proxyRes.trailers)
                res.end()
              })
              .on('close', () => {
                res.off('drain', onDrain)
              }))

            res.on('drain', onDrain)

            function onDrain () {
              proxyRes.resume()
            }
          }
        })
      } catch (err) {
        if (!err.statusCode) {
          throw err
        }

        error = err

        if (err.statusCode === 503) {
          continue
        }

        if (req.method === 'HEAD' || req.method === 'GET') {
          if (!bytesWritten) {
            continue
          }

          // TODO: Retry range request
        }

        throw err
      }
    }

    throw error || new createError.ServiceUnavailable()
  } catch (err) {
    defaultWebHandler(err)
  }
}
```

### `[async] web (req, res, options[, callback])`

- `req`: [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage) or [`http2.Http2ServerRequest`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverrequest).
- `res`: [`http.ServerResponse`](https://nodejs.org/api/http.html#http_class_http_serverresponse) or [`http2.Http2ServerResponse`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverresponse).
- `options`: See [Options](#options)
- `callback(err, req, res)`: Called on completion or error.

See [`request`](https://nodejs.org/api/http.html#http_event_request)

### `[async] ws (req, socket, head, options[, callback])`

- `req`: [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage).
- `socket`: [`net.Socket`](https://nodejs.org/api/net.html#net_class_net_socket).
- `head`: [`Buffer`](https://nodejs.org/api/buffer.html#buffer_class_buffer).
- `options`: See [Options](#options).
- `callback(err, req, socket, head)`: Called on completion or error.

See [`upgrade`](https://nodejs.org/api/http.html#http_event_upgrade)

### `options`

- `hostname`: Proxy [`http.request(options)`](https://nodejs.org/api/http.html#http_http_request_options_callback) target hostname.
- `port`: Proxy [`http.request(options)`](https://nodejs.org/api/http.html#http_http_request_options_callback) target port.
- `protocol`: Agent protocol (`'http'` or `'https'`). Defaults to `'http'`.
- `path`: Target pathname. Defaults to `req.originalUrl || req.url`.
- `proxyTimeout`: Proxy [`http.request(options)`](https://nodejs.org/api/http.html#http_http_request_options_callback) timeout.
- `proxyName`: Proxy name used for **Via** header.
- `[async] onReq(req, options[, callback])`: Called before proxy request. If returning a truthy value it will be used as the request.
  - `req`: [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage) or [`http2.Http2ServerRequest`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverrequest)
  - `options`: Options passed to [`http.request(options)`](https://nodejs.org/api/http.html#http_http_request_options_callback).
  - `callback(err)`: Called on completion or error.
- `[async] onRes(req, resOrSocket, proxyRes[, callback])`: Called on proxy response. Writing of response must be done inside this method if provided.
  - `req`: [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage) or [`http2.Http2ServerRequest`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverrequest).
  - `resOrSocket`: For `web` [`http.ServerResponse`](https://nodejs.org/api/http.html#http_class_http_serverresponse) or [`http2.Http2ServerResponse`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverresponse) and for `ws` [`net.Socket`](https://nodejs.org/api/net.html#net_class_net_socket).
  - `proxyRes`: [`http.ServerResponse`](https://nodejs.org/api/http.html#http_class_http_serverresponse).
  - `callback(err)`: Called on completion or error.

## License

  [MIT](LICENSE)

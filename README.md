# node-http2-proxy

A simple http/2 & http/1.1 to http/1.1 spec compliant proxy helper for Node.

### Features

- Proxies HTTP 2, HTTP 1 and WebSocket
- Simple and high performance
- [Hop by hop header handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers).
- [Connection header handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Connection)
- [Via header handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Via)
- [Forwarded header handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Forwarded)

### Installation

```sh
$ npm install http2-proxy
```

### Notes

`http2-proxy` requires at least node **v9.5.0**.

### HTTP/1 API

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

#### Proxy HTTP/2, HTTP/1 and WebSocket

```js
server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000
  }, err => {
    if (err) {
      console.error('proxy error', err)
    }
  })
})
server.on('upgrade', (req, socket, head) => {
  proxy.ws(req, socket, head, {
    hostname: 'localhost'
    port: 9000
  }, err => {
    if (err) {
      console.error('proxy error', err)
    }
  })
})
```

#### Use [Helmet](https://www.npmjs.com/package/helmet) to secure response headers

```javascript
server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000,
    onRes: (req, res) => helmet(req, res, () => {})
  }, err => {
    if (err) {
      console.error('proxy error', err)
    }
  })
})
```

#### Add x-forwarded headers

```javascript
server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000,
    onReq: (req, { headers }) => {
      headers['x-forwarded-for'] = req.socket.remoteAddress
      headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http'
      headers['x-forwarded-host'] = req.headers['host']
    }
  }, err => {
    if (err) {
      console.error('proxy error', err)
    }
  })
})
```

#### Follow Redirects

```javascript
const http = require('follow-redirects').http

server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000,
    onReq: (req, options) => http.request(options)
  }, err => {
    if (err) {
      console.error('proxy error', err)
    }
  })
})
```

#### Promise API

```javascript
server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000
  }).catch(err => {
    if (err) {
      console.error('proxy error', err)
    }
  })
})
```

#### web (req, res, options, [callback])

- `req`: [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage) or [`http2.Http2ServerRequest`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverrequest).
- `res`: [`http.ServerResponse`](https://nodejs.org/api/http.html#http_class_http_serverresponse) or [`http2.Http2ServerResponse`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverresponse).
- `options`: See [Options](#options)
- `callback(err)`: Called on completion or error. Optional.  See [Options](#options) for error behaviour..

Returns a promise if no callback is provided.

See [`request`](https://nodejs.org/api/http.html#http_event_request)

#### ws (req, socket, head, options, [callback])

- `req`: [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage).
- `socket`: [`net.Socket`](https://nodejs.org/api/net.html#net_class_net_socket).
- `head`: [`Buffer`](https://nodejs.org/api/buffer.html#buffer_class_buffer).
- `options`: See [Options](#options).
- `callback(err)`: Called on completion or error. Optional. See [Options](#options) for error behaviour.

Returns a promise if no callback is provided.

See [`upgrade`](https://nodejs.org/api/http.html#http_event_upgrade)

### Options

  - `hostname`: Proxy [`http.request(options)`](https://nodejs.org/api/http.html#http_http_request_options_callback) target hostname.
  - `port`: Proxy [`http.request(options)`](https://nodejs.org/api/http.html#http_http_request_options_callback) target port.
  - `proxyTimeout`: Proxy [`http.request(options)`](https://nodejs.org/api/http.html#http_http_request_options_callback) timeout.
  - `proxyName`: Proxy name used for **Via** header.
  - `timeout`: [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage) or [`http2.Http2ServerRequest`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverrequest) timeout.
  - `onReq(req, options)`: Called before proxy request. If returning a truthy value it will be used as the request.
    - `req`: [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage) or [`http2.Http2ServerRequest`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverrequest)
    - `options`: Options passed to [`http.request(options)`](https://nodejs.org/api/http.html#http_http_request_options_callback).
  - `onRes(req, resOrSocket, proxyRes)`: Called before proxy response.
    - `req`: [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage) or [`http2.Http2ServerRequest`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverrequest).
    - `resOrSocket`: For `web` [`http.ServerResponse`](https://nodejs.org/api/http.html#http_class_http_serverresponse) or [`http2.Http2ServerResponse`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverresponse) and for `ws` [`net.Socket`](https://nodejs.org/api/net.html#net_class_net_socket).
    - `proxyRes`: [`http.ServerResponse`](https://nodejs.org/api/http.html#http_class_http_serverresponse).
  - `endOnError`: End with status code or destroy response object on error. Defaults to `true`.
  - `endOnFinish`: End response object on finish. Defaults to `true`.

### License

  [MIT](LICENSE)

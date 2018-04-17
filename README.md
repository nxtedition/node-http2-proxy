# node-http2-proxy

A simple http/2 & http/1.1 to http/1.1 spec compliant proxy helper for Node.

### Version 3 Notes

- No longer handles closing the response. This is left to the user. 

One implementation for handling completion is as follows:

```js
function createHandler (callback) {
  return (err, req, res) => {
    if (err) {
      if (
        !res.writeHead ||
        res.headersSent !== false ||
        res.writable === false ||
        // NOTE: Checking only writable is not enough. See, https://github.com/nodejs/node/commit/8589c70c85411c2dd0e02c021d926b1954c74696
        res.finished === true
      ) {
        res.destroy()
      } else {
        res.writeHead(err.statusCode)
        res.end()
      }
    } else {
      res.end()
    }
    if (callback) {
      callback(err)
    }
  }
}

const defaultHandler = createHandler(err => {
  if (err) {
    console.error('proxy error', err)
  }
})
```

- No longer returns a promise if no callback is provided.

One implementation for promisifying the API is as follows:

```js
function promisify (fn) {
  return (...args) => new Promise((resolve, reject) => {
    fn(...args, createHandler(err => err ? reject(err) : resolve()))
  })
}

```

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

Request & Response errors are emitted to the server object either as `clientError` for http/1 or `streamError` for http/2. See the NodeJS documentation for further details.

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
  }, defaultHandler)
})
server.on('upgrade', (req, socket, head) => {
  proxy.ws(req, socket, head, {
    hostname: 'localhost'
    port: 9000
  }, defaultHandler)
})
```

#### Use [Helmet](https://www.npmjs.com/package/helmet) to secure response headers

```javascript
server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000,
    onRes: (req, res) => helmet(req, res, () => {})
  }, defaultHandler)
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
  }, defaultHandler)
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
  }, defaultHandler)
})
```

#### web (req, res, options, callback)

- `req`: [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage) or [`http2.Http2ServerRequest`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverrequest).
- `res`: [`http.ServerResponse`](https://nodejs.org/api/http.html#http_class_http_serverresponse) or [`http2.Http2ServerResponse`](https://nodejs.org/api/http2.html#http2_class_http2_http2serverresponse).
- `options`: See [Options](#options)
- `callback(err, req, res, { aborted })`: Called on completion or error. See [Options](#options) for error behaviour.

See [`request`](https://nodejs.org/api/http.html#http_event_request)

#### ws (req, socket, head, options, callback)

- `req`: [`http.IncomingMessage`](https://nodejs.org/api/http.html#http_class_http_incomingmessage).
- `socket`: [`net.Socket`](https://nodejs.org/api/net.html#net_class_net_socket).
- `head`: [`Buffer`](https://nodejs.org/api/buffer.html#buffer_class_buffer).
- `options`: See [Options](#options).
- `callback(err, req, res, { aborted })`: Called on completion or error. See [Options](#options) for error behaviour.

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

### License

  [MIT](LICENSE)

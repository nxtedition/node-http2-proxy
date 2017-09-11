# node-http2-proxy

A simple http/2 & http/1.1 to http/1.1 spec compliant proxy helper.

### Features

- Proxies HTTP 2, HTTP 1.1 and WebSocket
- Simple and easy to follow implementation
- [Hop by hop header handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers)
- [Connection header handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Connection)
- [Via header handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Via)
- [Forwarded header handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Forwarded)

### Installation

```sh
$ npm install http2-proxy
```

### Notes

`http2-proxy` requires node **v8.5.0** or newer with `http2` enabled. See [nightly node builds](https://nodejs.org/download/nightly/) or [building node from source](https://github.com/nodejs/node/blob/master/BUILDING.md#building-nodejs-on-supported-platforms). Pass the `--expose-http2` option when starting node **v8.x.x**.

### Usage

You must pass `allowHTTP1: true` to the `http2.createServer` or `http2.createSecureServer` factory methods.

```js
import http2 from 'http2'
import proxy from 'http2-proxy'

const server = http2.createServer({ allowHTTP1: true })
server.listen(8000)
```

#### Proxy HTTP 1.1/2 and WebSocket

```js
server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000
  }, err => console.error(err, 'proxy error'))
})
server.on('upgrade', (req, socket, head) => {
  proxy.ws(req, socket, head, {
    hostname: 'localhost'
    port: 9000
  }, err => console.error(err, 'proxy error'))
})
```

#### Use helmet to secure HTTP headers

`npm i helmet`

```javascript
import helmet from 'helmet'

server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000,
    onRes: (req, resHeaders) => helmet({
      setHeader (key, val) {
        resHeaders[key.trim().toLowerCase()] = val
      },
      getHeader (key) {
        return resHeaders[key.trim().toLowerCase()]
      },
      removeHeader (key) {
        delete resHeaders[key.trim().toLowerCase()]
      }
    }, () => {})
  }, err => console.error(err, 'proxy error'))
})
```

#### Add x-forwarded  headers

```javascript
server.on('request', (req, res) => {
  proxy.web(req, res, {
    hostname: 'localhost'
    port: 9000,
    onReq: (req, reqHeaders) => {
      reqHeaders['x-forwarded-for'] = req.socket.remoteAddress
      reqHeaders['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http'
      reqHeaders['x-forwarded-host'] = req.headers['host']
    }
  }, err => console.error(err, 'proxy error'))
})
```

### API

#### web (req, res, options, [onProxyError])

- `req`: `http.IncomingMessage` or `http2.Http2ServerRequest`
- `res`: `http.ServerResponse` or `http2.Http2ServerResponse`
- `options`: see [Options](#options)
- `onProxyError(err)`: called on error

#### ws (req, socket, head, options, [onProxyError])

- `req`: `http.IncomingMessage`
- `socket`: `net.Socket`
- `head`: `Buffer`
- `options`: see [Options](#options)
- `onProxyError(err)`: called on error

### Options

  - `hostname`: target hostname
  - `port`: target port
  - `timeout`: incoming request timeout
  - `proxyTimeout`: proxy request timeout
  - `proxyName`: proxy name used for **Via** header
  - `onReq(req, reqHeaders)`: called before proxy request
  - `onRes(req, resHeaders)`: called before proxy response

### License

>The MIT License (MIT)
>
>Copyright (c) 2017 Robert Nagy
>
>Permission is hereby granted, free of charge, to any person obtaining a copy
>of this software and associated documentation files (the "Software"), to deal
>in the Software without restriction, including without limitation the rights
>to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
>copies of the Software, and to permit persons to whom the Software is
>furnished to do so, subject to the following conditions:
>
>The above copyright notice and this permission notice shall be included in
>all copies or substantial portions of the Software.
>
>THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
>IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
>FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
>AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
>LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
>OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
>THE SOFTWARE.

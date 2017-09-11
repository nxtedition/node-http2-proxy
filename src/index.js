import createError from 'http-errors'
import http2 from 'http2'
import http from 'http'
import pump from 'pump'
import net from 'net'

const {
  HTTP2_HEADER_CONNECTION,
  HTTP2_HEADER_UPGRADE,
  HTTP2_HEADER_AUTHORITY,
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_SCHEME,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_HOST,
  HTTP2_HEADER_KEEP_ALIVE,
  HTTP2_HEADER_PROXY_CONNECTION,
  HTTP2_HEADER_TRANSFER_ENCODING,
  HTTP2_HEADER_TE,
  HTTP2_HEADER_PROXY_AUTHORIZATION,
  HTTP2_HEADER_HTTP2_SETTINGS,
  HTTP2_HEADER_VIA,
  // XXX https://github.com/nodejs/node/issues/15337
  HTTP2_HEADER_FORWARDED = 'forwarded'
} = http2.constants

const NODE_VER = process.version.match(/v(\d+).(\d+).(\d+)(?:-(.*))/).slice(1)

if (NODE_VER[0] < 9 && (NODE_VER[0] !== 8 || NODE_VER[1] > 4)) {
  throw new Error(`unsupported node version (${process.version} < 8.5.0)`)
}

export default {
  ws (req, socket, head, options, onProxyError) {
    impl(req, socket, head, options, onProxyError)
  },
  web (req, res, options, onProxyError) {
    impl(req, res, null, options, onProxyError)
  }
}

function impl (req, resOrSocket, headOrNil, {
  hostname,
  port,
  timeout,
  proxyTimeout,
  proxyName,
  onReq,
  onRes
}, onProxyError) {
  function onError (err, statusCode = (err && err.statusCode) || 500) {
    if (resOrSocket.closed === true ||
        resOrSocket.headersSent !== false ||
        !resOrSocket.writeHead
    ) {
      resOrSocket.destroy()
    } else {
      resOrSocket.writeHead(statusCode)
      resOrSocket.end()
    }

    onProxyError(err, req, resOrSocket)
  }

  try {
    if (resOrSocket instanceof net.Socket) {
      if (req.method !== 'GET') {
        throw new createError.MethodNotAllowed()
      }

      if (!req.headers[HTTP2_HEADER_UPGRADE] ||
          req.headers[HTTP2_HEADER_UPGRADE].toLowerCase() !== 'websocket') {
        throw new createError.BadRequest()
      }
    }

    if (!/1\.1|2\.\d/.test(req.httpVersion)) {
      throw new createError.HTTPVersionNotSupported()
    }

    if (proxyName &&
        req.headers[HTTP2_HEADER_VIA] &&
        req.headers[HTTP2_HEADER_VIA]
          .split(',')
          .some(name => name.trim().toLowerCase().endsWith(proxyName.toLowerCase()))
    ) {
      throw new createError.LoopDetected()
    }

    if (timeout) {
      req.setTimeout(timeout, () => onError(new createError.RequestTimeout()))
    }

    (req.stream || req).on('error', onError)

    if (resOrSocket instanceof net.Socket) {
      if (headOrNil && headOrNil.length) {
        resOrSocket.unshift(headOrNil)
      }

      setupSocket(resOrSocket)
    }

    const headers = getRequestHeaders(req)

    if (proxyName) {
      if (headers[HTTP2_HEADER_VIA]) {
        headers[HTTP2_HEADER_VIA] += `,${proxyName}`
      } else {
        headers[HTTP2_HEADER_VIA] = proxyName
      }
    }

    if (onReq) {
      onReq(req, headers)
    }

    return proxy(req, resOrSocket, {
      method: req.method,
      hostname,
      port,
      path: req.url,
      headers,
      timeout: proxyTimeout
    }, onRes, onError)
  } catch (err) {
    return onError(err)
  }
}

function proxy (req, resOrSocket, options, onRes, onError) {
  const proxyReq = http.request(options)

  const callback = err => {
    if (!proxyReq.aborted) {
      proxyReq.abort()
    }
    onError(err)
  }

  req
    .pipe(proxyReq)
    .on('error', err => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        callback(new createError.ServiceUnavailable(err.message))
      } else if (/HPE_INVALID/.test(err.code)) {
        callback(new createError.BadGateway(err.message))
      } else {
        callback(err)
      }
    })
    .on('timeout', () => callback(new createError.GatewayTimeout()))
    .on('response', proxyRes => {
      try {
        proxyRes.on('aborted', () => callback(new createError.BadGateway('socket hang up')))

        if (resOrSocket instanceof net.Socket) {
          if (!proxyRes.upgrade) {
            resOrSocket.end()
          }
        } else {
          const headers = setupHeaders({ ...proxyRes.headers })

          if (onRes) {
            onRes(req, headers)
          }

          resOrSocket.writeHead(proxyRes.statusCode, headers)
          proxyRes.on('end', () => {
            resOrSocket.addTrailers(proxyRes.trailers)
          })
          pump(proxyRes, resOrSocket, err => err && callback(err))
        }
      } catch (err) {
        callback(err)
      }
    })

  if (resOrSocket instanceof net.Socket) {
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      try {
        setupSocket(proxySocket)

        if (proxyHead && proxyHead.length) {
          proxySocket.unshift(proxyHead)
        }

        resOrSocket.write(
          Object
            .keys(proxyRes.headers)
            .reduce((head, key) => {
              const value = proxyRes.headers[key]

              if (!Array.isArray(value)) {
                head.push(key + ': ' + value)
                return head
              }

              for (let i = 0; i < value.length; i++) {
                head.push(key + ': ' + value[i])
              }

              return head
            }, ['HTTP/1.1 101 Switching Protocols'])
            .join('\r\n') + '\r\n\r\n'
        )

        pump(proxySocket, resOrSocket, proxySocket, err => err && callback(err))
      } catch (err) {
        callback(err)
      }
    })
  }
}

function getRequestHeaders (req) {
  const headers = setupHeaders({ ...req.headers })

  // Remove pseudo headers
  delete headers[HTTP2_HEADER_AUTHORITY]
  delete headers[HTTP2_HEADER_METHOD]
  delete headers[HTTP2_HEADER_PATH]
  delete headers[HTTP2_HEADER_SCHEME]

  if (req.headers[HTTP2_HEADER_UPGRADE]) {
    headers[HTTP2_HEADER_CONNECTION] = 'upgrade'
    headers[HTTP2_HEADER_UPGRADE] = 'websocket'
  }

  const fwd = {
    by: req.headers[HTTP2_HEADER_AUTHORITY] || req.headers[HTTP2_HEADER_HOST],
    proto: req.socket.encrypted ? 'https' : 'http',
    // TODO: Is this correct?
    for: [ req.socket.remoteAddress ]
  }

  if (req.headers[HTTP2_HEADER_FORWARDED]) {
    const expr = /for=\s*([^\s]+)/i
    while (true) {
      const m = expr.exec(req.headers[HTTP2_HEADER_FORWARDED])
      if (!m) {
        break
      }
      fwd.for.push(m)
    }
  }

  headers[HTTP2_HEADER_FORWARDED] = [
    `by=${fwd.by}`,
    fwd.for.map(address => `for=${address}`).join('; '),
    fwd.host && `host=${fwd.host}`,
    `proto=${fwd.proto}`
  ].filter(x => x).join('; ')

  return headers
}

function setupSocket (socket) {
  socket.setTimeout(0)
  socket.setNoDelay(true)
  socket.setKeepAlive(true, 0)
}

function setupHeaders (headers) {
  const connection = headers[HTTP2_HEADER_CONNECTION]

  if (connection && connection !== 'close') {
    for (const key of connection.split(',')) {
      delete headers[key.trim().toLowerCase()]
    }
  }

  delete headers[HTTP2_HEADER_CONNECTION]
  delete headers[HTTP2_HEADER_KEEP_ALIVE]
  delete headers[HTTP2_HEADER_TRANSFER_ENCODING]
  delete headers[HTTP2_HEADER_TE]
  delete headers[HTTP2_HEADER_UPGRADE]
  delete headers[HTTP2_HEADER_PROXY_AUTHORIZATION]
  delete headers[HTTP2_HEADER_PROXY_CONNECTION]
  delete headers[HTTP2_HEADER_HTTP2_SETTINGS]

  return headers
}

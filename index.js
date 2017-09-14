const http2 = require('http2')
const http = require('http')
const net = require('net')

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

module.exports = {
  ws (req, socket, head, options, callback) {
    impl(req, socket, head, options, callback)
  },
  web (req, res, options, callback) {
    impl(req, res, null, options, callback)
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
}, callback) {
  if (resOrSocket instanceof net.Socket) {
    if (req.method !== 'GET') {
      return onFinish(createError('method not allowed', null, 405))
    }

    if (!req.headers[HTTP2_HEADER_UPGRADE] ||
        req.headers[HTTP2_HEADER_UPGRADE].toLowerCase() !== 'websocket') {
      return onFinish(createError('bad request', null, 400))
    }
  }

  if (req.httpVersion !== '1.1' && req.httpVersion !== '2.0') {
    return onFinish(createError('http version not supported', null, 505))
  }

  if (proxyName && req.headers[HTTP2_HEADER_VIA]) {
    for (const name of req.headers[HTTP2_HEADER_VIA].split(',')) {
      if (sanitize(name).endsWith(proxyName.toLowerCase())) {
        return onFinish(createError('loop detected', null, 508))
      }
    }
  }

  if (timeout) {
    req.setTimeout(timeout, () => onFinish(createError('request timeout', null, 408)))
  }

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

  const options = {
    method: req.method,
    hostname,
    port,
    path: req.url,
    headers,
    timeout: proxyTimeout
  }

  if (onReq) {
    onReq(req, options)
  }

  const proxyReq = http.request(options)

  resOrSocket
    .on('finish', onFinish)
    .on('close', onFinish)
    .on('error', onFinish)

  req
    .on('aborted', onFinish)
    .on('close', onFinish)
    .on('error', onFinish)
    .pipe(proxyReq)
    .on('error', onFinish)
    // NOTE http.ClientRequest emits "socket hang up" error when aborted
    // before having received a response, i.e. there is no need to listen for
    // proxyReq.on('aborted', ...).
    .on('timeout', () => onFinish(createError('gateway timeout', null, 504)))
    .on('response', onProxyResponse)
    .on('upgrade', onProxyUpgrade)

  let hasError = false

  function onFinish (err, statusCode = err.statusCode || 500) {
    if (hasError) {
      return
    }

    if (proxyReq && !proxyReq.aborted) {
      proxyReq.abort()
    }

    if (!err) {
      return
    }

    hasError = true

    if (!err.code) {
      err.code = resOrSocket.code
    }

    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      err.statusCode = 503
    } else if (/HPE_INVALID/.test(err.code)) {
      err.statusCode = 502
    } else if (err.code === 'ECONNRESET') {
      err.statusCode = 502
    }

    if (resOrSocket.closed === true ||
        resOrSocket.headersSent !== false ||
        !resOrSocket.writeHead
    ) {
      resOrSocket.destroy()
    } else {
      resOrSocket.writeHead(statusCode)
      resOrSocket.end()
    }

    if (callback) {
      callback(err, req, resOrSocket)
    } else {
      throw err
    }
  }

  function onProxyResponse (proxyRes) {
    if (this.aborted) {
      return
    }

    proxyRes.on('aborted', () => onFinish(createError('socket hang up', 'ECONNRESET', 502)))

    if (resOrSocket instanceof net.Socket) {
      if (!proxyRes.upgrade) {
        resOrSocket.end()
      }
    } else {
      setupHeaders(proxyRes.headers)

      resOrSocket.statusCode = proxyRes.statusCode
      for (const key of Object.keys(proxyRes.headers)) {
        resOrSocket.setHeader(key, proxyRes.headers[key])
      }

      if (onRes) {
        onRes(req, resOrSocket)
      }

      resOrSocket.writeHead(resOrSocket.statusCode)
      proxyRes
        .on('end', () => resOrSocket.addTrailers(proxyRes.trailers))
        .on('error', onFinish)
        .pipe(resOrSocket)
    }
  }

  function onProxyUpgrade (proxyRes, proxySocket, proxyHead) {
    if (this.aborted) {
      return
    }

    setupSocket(proxySocket)

    if (proxyHead && proxyHead.length) {
      proxySocket.unshift(proxyHead)
    }

    let head = 'HTTP/1.1 101 Switching Protocols'

    for (const key of Object.keys(proxyRes.headers)) {
      const value = proxyRes.headers[key]

      if (!Array.isArray(value)) {
        head += '\r\n' + key + ': ' + value
      } else {
        for (let i = 0; i < value.length; i++) {
          head += '\r\n' + key + ': ' + value[i]
        }
      }
    }

    head += '\r\n\r\n'

    resOrSocket.write(head)

    proxyRes.on('error', onFinish)

    proxySocket
      .on('error', onFinish)
      .pipe(resOrSocket)
      .pipe(proxySocket)
  }
}

function getRequestHeaders (req) {
  const host = req.headers[HTTP2_HEADER_AUTHORITY] || req.headers[HTTP2_HEADER_HOST]
  const upgrade = req.headers[HTTP2_HEADER_UPGRADE]
  const forwarded = req.headers[HTTP2_HEADER_FORWARDED]

  const headers = setupHeaders(Object.assign({}, req.headers))

  // Remove pseudo headers
  delete headers[HTTP2_HEADER_AUTHORITY]
  delete headers[HTTP2_HEADER_METHOD]
  delete headers[HTTP2_HEADER_PATH]
  delete headers[HTTP2_HEADER_SCHEME]

  if (upgrade) {
    headers[HTTP2_HEADER_CONNECTION] = 'upgrade'
    headers[HTTP2_HEADER_UPGRADE] = 'websocket'
  }

  headers[HTTP2_HEADER_FORWARDED] = `by=${req.socket.localAddress}`
  headers[HTTP2_HEADER_FORWARDED] += `; for=${req.socket.remoteAddress}`

  if (forwarded) {
    const expr = /for=\s*([^\s]+)/ig
    while (true) {
      const m = expr.exec(forwarded)
      if (!m) {
        break
      }
      headers[HTTP2_HEADER_FORWARDED] += `; ${m[1]}`
    }
  }

  if (host) {
    headers[HTTP2_HEADER_FORWARDED] += `; host=${host}`
  }

  headers[HTTP2_HEADER_FORWARDED] += `; proto=${req.socket.encrypted ? 'https' : 'http'}`

  return headers
}

function setupSocket (socket) {
  socket.setTimeout(0)
  socket.setNoDelay(true)
  socket.setKeepAlive(true, 0)
}

function setupHeaders (headers) {
  const connection = sanitize(headers[HTTP2_HEADER_CONNECTION])

  if (connection && connection !== 'close' && connection !== 'keep-alive') {
    for (const name of connection.split(',')) {
      delete headers[sanitize(name)]
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

function sanitize (name) {
  return name ? name.trim().toLowerCase() : ''
}

function createError (msg, code, statusCode) {
  const err = new Error(msg)
  err.code = code
  err.statusCode = statusCode
  return err
}

const proxy = require('../index')
const http = require('http')

test('onReq and onRes are optional', async () => {
  let server
  let proxyServer
  let req
  try {
    await new Promise(resolve => {
      server = http.createServer((req, res) => {
        res.end()
      }).listen(0)
      proxyServer = http.createServer((req, res) => {
        proxy.web(req, res, { port: server.address().port })
      }).listen(0, () => {
        req = http
          .get({ port: proxyServer.address().port })
          .on('response', resolve)
          .end()
      })
    })
  } finally {
    server.close()
    proxyServer.close()
    req.abort()
  }
})

test('onReq sets path', async () => {
  let server
  let proxyServer
  let req
  try {
    await new Promise(resolve => {
      server = http.createServer((req, res) => {
        expect(req.url).toEqual('/test')
        res.end()
      }).listen(0)
      proxyServer = http.createServer((req, res) => {
        proxy.web(req, res, { port: server.address().port, path: '/test' })
      }).listen(0, () => {
        req = http
          .get({ port: proxyServer.address().port })
          .on('response', resolve)
          .end()
      })
    })
  } finally {
    server.close()
    proxyServer.close()
    req.abort()
  }
})

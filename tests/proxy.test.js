const proxy = require('../index')
const http = require('http')

test('proxies when socket is sync', async () => {
  let server
  let proxyServer
  let req
  try {
    await new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        res.end()
      }).listen(0)
      proxyServer = http.createServer((req, res) => {
        proxy({ req, res }, options => new Promise(resolve => {
          options.port = server.address().port
          const ureq = http.request(options)
          ureq.on('socket', () => resolve(ureq))
        }))
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

test('proxies when socket is async', async () => {
  let server
  let proxyServer
  let req
  try {
    await new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        res.end()
      }).listen(0)
      proxyServer = http.createServer((req, res) => {
        proxy({ req, res }, options => {
          options.port = server.address().port
          return http.request(options)
        })
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

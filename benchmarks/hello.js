const cluster = require('cluster')

if (cluster.isMaster) {
  for (let n = 0; n < 8; ++n) {
    cluster.fork()
  }
} else {
  require('http').createServer((req, res) => {
    res.end('Hello world!')
  }).listen(9000)
}

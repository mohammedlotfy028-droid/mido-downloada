// Small HTTP server for testing: serves one file with Range support and a per-connection
// speed limit, so downloads take long enough to pause / kill / resume.
// Usage: node test/server.js <file> <port> [bytesPerSecondPerConnection]
const fs = require('fs');
const http = require('http');

const [file, port = 8765, bps = 256 * 1024] = process.argv.slice(2);
const size = fs.statSync(file).size;

// Paths like /fail-503-3/x.bin answer HTTP 503 to the first 3 requests, then work.
// /fail-404-0/x.bin is never found. Used to test automatic retry.
const failures = new Map();

http
  .createServer((req, res) => {
    const f = /\/fail-(\d{3})-(\d+)\//.exec(req.url);
    if (f) {
      const seen = failures.get(req.url) || 0;
      failures.set(req.url, seen + 1);
      const [, code, times] = f;
      if (code === '404' || seen < Number(times)) {
        res.writeHead(Number(code));
        return res.end();
      }
    }
    // /auth/... needs HTTP Basic login test:secret ; /ua/... needs User-Agent "MidoTest/1.0"
    if (req.url.startsWith('/auth/') && req.headers.authorization !== `Basic ${Buffer.from('test:secret').toString('base64')}`) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      return res.end();
    }
    if (req.url.startsWith('/ua/') && req.headers['user-agent'] !== 'MidoTest/1.0') {
      res.writeHead(403);
      return res.end();
    }
    let start = 0;
    let end = size - 1;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      if (m[1]) start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      });
    } else {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    }
    if (req.method === 'HEAD') return res.end();

    const stream = fs.createReadStream(file, { start, end, highWaterMark: 16 * 1024 });
    const chunkDelay = (16 * 1024 * 1000) / Number(bps);
    stream.on('data', (chunk) => {
      stream.pause();
      if (!res.write(chunk)) res.once('drain', () => setTimeout(() => stream.resume(), chunkDelay));
      else setTimeout(() => stream.resume(), chunkDelay);
    });
    stream.on('end', () => res.end());
    res.on('close', () => stream.destroy());
  })
  .listen(Number(port), '127.0.0.1', () => console.log(`test server on ${port}, ${size} bytes`));

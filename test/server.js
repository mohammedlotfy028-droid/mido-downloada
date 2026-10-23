// Small HTTP server for testing: serves one file with Range support and a per-connection
// speed limit, so downloads take long enough to pause / kill / resume.
// Usage: node test/server.js <file> <port> [bytesPerSecondPerConnection]
const fs = require('fs');
const http = require('http');

const [file, port = 8765, bps = 256 * 1024] = process.argv.slice(2);
const size = fs.statSync(file).size;

http
  .createServer((req, res) => {
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

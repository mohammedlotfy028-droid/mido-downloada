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
const stats = { denied: 0, allowed: 0 }; // requests to /site/protected/*

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

    // ----- a small "website" for the browser-extension test -----
    // /site/login sets a session cookie; /site/protected/* needs that cookie AND a Referer
    // from /site/; /site/page.html has download links and a video.
    const host = `http://${req.headers.host}`;
    if (req.url === '/site/login') {
      res.writeHead(302, { 'Set-Cookie': 'sid=abc123; HttpOnly; Path=/', Location: '/site/page.html' });
      return res.end();
    }
    if (req.url === '/site/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><title>Test site</title><body style="font:16px sans-serif;padding:20px">
        <p><a id="dl" href="/site/protected/archive.zip">archive.zip (40 MB, login needed)</a></p>
        <p><a id="small" href="/site/files/readme.txt">readme.txt (small)</a></p>
        <video id="v" src="/site/media/clip.mp4" preload="auto" muted autoplay width="320"></video></body>`);
    }
    if (req.url === '/site/files/readme.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="readme.txt"' });
      return res.end('hello from the test site\n');
    }
    if (req.url === '/__stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(stats));
    }
    if (req.url.startsWith('/site/protected/')) {
      const okCookie = /(?:^|;\s*)sid=abc123(?:;|$)/.test(req.headers.cookie || '');
      const okReferer = String(req.headers.referer || '').startsWith(`${host}/site/`);
      if (!okCookie || !okReferer) {
        stats.denied++;
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end(`forbidden (cookie:${okCookie} referer:${okReferer})`);
      }
      stats.allowed++;
    }
    const name = req.url.split('?')[0].split('/').pop();
    const type = /\.mp4$/.test(name) ? 'video/mp4' : /\.zip$/.test(name) ? 'application/zip' : 'application/octet-stream';
    const extra = { 'Content-Type': type };
    if (req.url.startsWith('/site/protected/')) extra['Content-Disposition'] = `attachment; filename="${name}"`;

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
        ...extra,
      });
    } else {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes', ...extra });
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

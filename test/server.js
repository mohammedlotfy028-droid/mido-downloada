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
    // /static/<file> serves files from STATIC_DIR (HLS playlists + segments, test videos).
    if (req.url.startsWith('/static/') && process.env.STATIC_DIR) {
      const root = require('path').resolve(process.env.STATIC_DIR);
      const f = require('path').join(root, decodeURIComponent(req.url.slice(8).split('?')[0]));
      if (!f.startsWith(root) || !fs.existsSync(f)) {
        res.writeHead(404);
        return res.end();
      }
      const types = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.html': 'text/html' };
      const total = fs.statSync(f).size;
      const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      const type = types[require('path').extname(f)] || 'application/octet-stream';
      if (r) {
        const a = Number(r[1] || 0);
        const b = r[2] ? Number(r[2]) : total - 1;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes' });
        return fs.createReadStream(f, { start: a, end: b }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': total, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(f).pipe(res);
    }
    // Tiny BitTorrent tracker: every torrent's only peer is the test seeder (SEED_PORT).
    if (req.url.startsWith('/announce')) {
      const port = Number(process.env.SEED_PORT || 0);
      const peer = Buffer.from([127, 0, 0, 1, port >> 8, port & 255]); // compact form
      const body = Buffer.concat([Buffer.from('d8:intervali30e5:peers6:'), peer, Buffer.from('e')]);
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
      return res.end(body);
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

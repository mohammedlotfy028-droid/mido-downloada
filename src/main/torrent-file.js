// Reads a .torrent file (bencode) to show its name, size and files before downloading.
const fs = require('fs');

/** Minimal bencode decoder. Byte strings come back as Buffers. */
function decode(buf) {
  let i = 0;
  function next() {
    const c = buf[i];
    if (c === 0x69) {
      // i<number>e
      const end = buf.indexOf(0x65, i);
      const n = Number(buf.toString('ascii', i + 1, end));
      i = end + 1;
      return n;
    }
    if (c === 0x6c) {
      // l<items>e
      i++;
      const list = [];
      while (buf[i] !== 0x65) list.push(next());
      i++;
      return list;
    }
    if (c === 0x64) {
      // d<key><value>…e
      i++;
      const dict = {};
      while (buf[i] !== 0x65) {
        const key = next().toString('utf8');
        dict[key] = next();
      }
      i++;
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) {
      // <length>:<bytes>
      const colon = buf.indexOf(0x3a, i);
      const len = Number(buf.toString('ascii', i, colon));
      const start = colon + 1;
      i = start + len;
      if (i > buf.length) throw new Error('truncated');
      return buf.subarray(start, i);
    }
    throw new Error(`bad bencode at ${i}`);
  }
  return next();
}

/** @returns {{name:string, size:number, files:Array<{path:string,size:number}>}} */
function readTorrent(file) {
  const stat = fs.statSync(file);
  if (stat.size > 20 * 1024 * 1024) throw new Error('not a torrent file (too big)');
  const t = decode(fs.readFileSync(file));
  if (!t || !t.info) throw new Error('not a torrent file');
  const info = t.info;
  const str = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b || ''));
  const name = str(info['name.utf-8'] || info.name);
  const files = Array.isArray(info.files)
    ? info.files.map((f) => ({ path: (f['path.utf-8'] || f.path).map(str).join('/'), size: f.length }))
    : [{ path: name, size: info.length }];
  return { name, size: files.reduce((s, f) => s + (f.size || 0), 0), files };
}

module.exports = { decode, readTorrent };

// Test helpers: make .torrent files (bencode) for local content.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function encode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (typeof v === 'string') return encode(Buffer.from(v, 'utf8'));
  if (typeof v === 'number') return Buffer.from(`i${Math.floor(v)}e`);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(encode), Buffer.from('e')]);
  // dictionary: keys must be sorted (raw byte order)
  const keys = Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((k) => [encode(k), encode(v[k])]), Buffer.from('e')]);
}

/**
 * Makes a torrent for a single file or a folder.
 * @returns {{ torrent: Buffer, infoHash: string }}
 */
function makeTorrent(target, announce, pieceLength = 256 * 1024) {
  const isDir = fs.statSync(target).isDirectory();
  const files = isDir
    ? fs.readdirSync(target).sort().map((f) => ({ abs: path.join(target, f), rel: [f] }))
    : [{ abs: target, rel: [path.basename(target)] }];
  const data = Buffer.concat(files.map((f) => fs.readFileSync(f.abs)));
  const pieces = [];
  for (let i = 0; i < data.length; i += pieceLength) {
    pieces.push(crypto.createHash('sha1').update(data.subarray(i, i + pieceLength)).digest());
  }
  const info = { name: path.basename(target), 'piece length': pieceLength, pieces: Buffer.concat(pieces) };
  if (isDir) info.files = files.map((f) => ({ length: fs.statSync(f.abs).size, path: f.rel }));
  else info.length = data.length;
  const infoHash = crypto.createHash('sha1').update(encode(info)).digest('hex');
  return { torrent: encode({ announce, info }), infoHash };
}

module.exports = { encode, makeTorrent };

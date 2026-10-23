// Checksums: parse what the user pastes ("sha256:abc…", "SHA-256 abc…", or just the hex)
// and compute a file's hash.
const crypto = require('crypto');
const fs = require('fs');

// hex length -> algorithm, for when the user pastes just the hash
const BY_LENGTH = { 32: 'md5', 40: 'sha-1', 64: 'sha-256', 96: 'sha-384', 128: 'sha-512' };
const NODE_NAME = { md5: 'md5', 'sha-1': 'sha1', 'sha-256': 'sha256', 'sha-384': 'sha384', 'sha-512': 'sha512' };

/**
 * @returns {null | {algo:string, hex:string, aria2:string}} null when empty
 * @throws Error('BAD_CHECKSUM') when it doesn't look like a checksum
 */
function parseChecksum(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = /^(?:(md5|sha-?1|sha-?256|sha-?384|sha-?512)\s*[:= ]\s*)?([0-9a-f]+)$/i.exec(s);
  if (!m) throw new Error('BAD_CHECKSUM');
  const hex = m[2].toLowerCase();
  let algo = m[1] ? m[1].toLowerCase().replace(/^sha-?/, 'sha-') : BY_LENGTH[hex.length];
  if (algo === 'sha-md5') algo = 'md5';
  if (!algo || BY_LENGTH[hex.length] !== algo) throw new Error('BAD_CHECKSUM');
  return { algo, hex, aria2: `${algo}=${hex}` };
}

/** Hash of a file, streamed (works for multi-GB files without loading them in memory). */
function hashFile(file, algo = 'sha-256') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(NODE_NAME[algo] || 'sha256');
    fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

module.exports = { parseChecksum, hashFile };

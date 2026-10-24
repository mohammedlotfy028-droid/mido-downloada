// Which browser downloads should go to Mido Download instead of the browser?
// Loaded by background.js (importScripts), so everything here is global.

const MIDO_FILE_TYPES = new Set([
  // video
  'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts',
  // music
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma',
  // programs / disk images
  'exe', 'msi', 'msix', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'iso', 'img',
  // archives
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab',
  // documents that are often big
  'pdf', 'epub', 'djvu',
]);

/** Downloads smaller than this stay in the browser (unless the type is in the list). */
const MIDO_MIN_SIZE = 2 * 1024 * 1024; // 2 MB

function midoExtOf(name) {
  const m = /\.([a-z0-9]{1,9})$/i.exec(String(name || '').split(/[?#]/)[0]);
  return m ? m[1].toLowerCase() : '';
}

/**
 * @param {{url:string, filename:string, mime:string, size:number}} d
 *   size is 0 when the server didn't say how big the file is.
 * @returns {boolean} true = send to Mido Download, false = let the browser download it
 */
function shouldCapture(d) {
  // Links the app can't open (made inside the page, or already on disk).
  if (!/^(https?|ftp):/i.test(d.url)) return false;

  let path = '';
  try {
    path = decodeURIComponent(new URL(d.url).pathname);
  } catch {}
  const ext = midoExtOf(d.filename) || midoExtOf(path);
  const mime = String(d.mime || '').toLowerCase();

  // TODO(Mohammed): this is the trade-off to tune.
  // Current rule: known file types always go to the app; anything else only when it's big.
  // Ideas: never catch PDFs (people often just want to view them), or catch everything
  // over 1 MB no matter the type, or skip some sites entirely.
  if (MIDO_FILE_TYPES.has(ext)) return true;
  if (/^(video|audio)\//.test(mime)) return true;
  return d.size >= MIDO_MIN_SIZE;
}

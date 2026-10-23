// File type -> category. Each category has its own sub-folder inside the download folder.
const CATEGORIES = {
  video: {
    folder: 'Video',
    ext: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts', 'vob'],
  },
  music: {
    folder: 'Music',
    ext: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'alac', 'aiff', 'mid', 'midi'],
  },
  programs: {
    folder: 'Programs',
    ext: ['exe', 'msi', 'msix', 'appx', 'apk', 'xapk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'bat', 'iso', 'img'],
  },
  compressed: {
    folder: 'Compressed',
    ext: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'cab', 'lz', 'lzma'],
  },
  documents: {
    folder: 'Documents',
    ext: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'txt', 'rtf', 'csv', 'epub', 'mobi', 'djvu'],
  },
};

const BY_EXT = new Map();
for (const [key, c] of Object.entries(CATEGORIES)) for (const e of c.ext) BY_EXT.set(e, key);

function extOf(name) {
  const m = /\.([a-z0-9]{1,9})$/i.exec(String(name || '').split(/[?#]/)[0]);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Category for a file. Falls back to the MIME type when the name has no known extension.
 * @returns {'video'|'music'|'programs'|'compressed'|'documents'|null}
 */
function categoryOf(fileName, mimeType = '') {
  const byExt = BY_EXT.get(extOf(fileName));
  if (byExt) return byExt;
  const mime = String(mimeType).toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'music';
  if (/zip|rar|7z|compressed|x-tar|gzip/.test(mime)) return 'compressed';
  if (/pdf|msword|officedocument|text\/plain/.test(mime)) return 'documents';
  if (/msdownload|x-msi|android\.package/.test(mime)) return 'programs';
  return null;
}

/** True if a URL looks like a direct link to a file (used by the clipboard watcher). */
function looksLikeFileUrl(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:', 'ftp:'].includes(u.protocol)) return false;
    return BY_EXT.has(extOf(decodeURIComponent(u.pathname)));
  } catch {
    return false;
  }
}

module.exports = { CATEGORIES, categoryOf, extOf, looksLikeFileUrl };

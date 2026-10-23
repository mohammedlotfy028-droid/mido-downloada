// Looks at a link before downloading: real file name, size, type and resume support.
// Uses a 1-byte range request (some servers reject HEAD), follows redirects.
const path = require('path');

function fileNameFromDisposition(header) {
  if (!header) return '';
  // RFC 5987: filename*=UTF-8''name%20here.zip
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {}
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  return plain ? (plain[2] ?? plain[1]).trim() : '';
}

function fileNameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last);
  } catch {
    return '';
  }
}

/** Removes characters Windows doesn't allow in file names. */
function safeFileName(name) {
  return path.basename(String(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 200);
}

/**
 * @returns {Promise<{ok:boolean, name:string, size:number, type:string, resumable:boolean, finalUrl:string, error?:string}>}
 */
async function probe(url, { userAgent, login, extraHeaders = [] } = {}) {
  const headers = { Range: 'bytes=0-0' };
  // extraHeaders: ["Cookie: a=b", "Referer: https://…"] (from the browser extension)
  for (const h of extraHeaders) {
    const i = h.indexOf(':');
    if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  if (userAgent) headers['User-Agent'] = userAgent;
  if (login) headers.Authorization = `Basic ${Buffer.from(`${login.user}:${login.pass}`).toString('base64')}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    // We only need the headers; stop the body right away.
    res.body?.cancel().catch(() => {});
    if (!res.ok) return { ok: false, name: safeFileName(fileNameFromUrl(url)), size: 0, type: '', resumable: false, finalUrl: url, error: `HTTP ${res.status}` };
    const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') || '');
    const size = range ? Number(range[1]) : res.status === 200 ? Number(res.headers.get('content-length') || 0) : 0;
    const name =
      fileNameFromDisposition(res.headers.get('content-disposition')) ||
      fileNameFromUrl(res.url) ||
      fileNameFromUrl(url);
    return {
      ok: true,
      name: safeFileName(name || 'download'),
      size,
      type: (res.headers.get('content-type') || '').split(';')[0].trim(),
      resumable: res.status === 206,
      finalUrl: res.url,
    };
  } catch (e) {
    return { ok: false, name: safeFileName(fileNameFromUrl(url)), size: 0, type: '', resumable: false, finalUrl: url, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { probe, safeFileName };

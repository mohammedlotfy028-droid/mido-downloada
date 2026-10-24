// Local HTTP server the browser extension talks to (127.0.0.1 only, fixed port).
//
// Security:
//  - Only requests made by a browser extension are accepted: browsers set the Origin
//    header themselves (chrome-extension://…), web pages can't fake it.
//  - Host must be 127.0.0.1/localhost:<port> (blocks DNS-rebinding tricks).
//  - Sending downloads needs a token. A token is only handed out after the user
//    approves the pairing in the app. Only a hash of each token is stored.
const crypto = require('crypto');
const http = require('http');

const PORT = 47811;
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|extension):\/\/[a-z0-9-]+$/i;
const MAX_BODY = 256 * 1024;

class BrowserBridge {
  /**
   * @param {object} o
   * @param {import('./settings').Settings} o.settings
   * @param {string} o.version
   * @param {(name:string) => Promise<boolean>} o.onPairRequest asks the user
   * @param {(req:object) => Promise<void>|void} o.onDownload a link sent by the extension
   */
  constructor({ settings, version, onPairRequest, onDownload, port = PORT }) {
    Object.assign(this, { settings, version, onPairRequest, onDownload, port });
    this.server = null;
    this.error = '';
    this.pairing = false;
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
      console.error('[bridge]', e);
      this.reply(res, 500, { error: 'internal' });
    }));
    this.server.on('error', (e) => {
      this.error = e.code === 'EADDRINUSE' ? `port ${this.port} is in use` : e.message;
      console.error('[bridge] could not start:', this.error);
    });
    this.server.listen(this.port, '127.0.0.1', () => console.log(`[bridge] listening on 127.0.0.1:${this.port}`));
  }

  stop() {
    if (this.server) this.server.close();
  }

  reply(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new Error('bad json'));
        }
      });
      req.on('error', reject);
    });
  }

  async handle(req, res) {
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.reply(res, 403, { error: 'host' });
    if (!EXTENSION_ORIGIN.test(String(req.headers.origin || ''))) return this.reply(res, 403, { error: 'origin' });

    const token = /^Bearer (\S+)$/.exec(String(req.headers.authorization || ''))?.[1];
    const paired = this.settings.isValidBrowserToken(token);
    const enabled = this.settings.values.browserEnabled;
    const route = `${req.method} ${req.url.split('?')[0]}`;

    // POST even for reading: browsers only send the Origin header on POST requests
    // from extensions, and we need it on every request.
    if (route === 'POST /v1/status') {
      return this.reply(res, 200, { app: 'mido-downloada', version: this.version, enabled, paired });
    }

    if (!enabled) return this.reply(res, 503, { error: 'disabled' });

    if (route === 'POST /v1/pair') {
      const body = await this.readBody(req).catch(() => null);
      if (!body) return this.reply(res, 400, { error: 'bad request' });
      if (this.pairing) return this.reply(res, 429, { error: 'busy' });
      this.pairing = true;
      try {
        const name = String(body.name || 'Browser').slice(0, 80);
        const approved = await Promise.race([
          this.onPairRequest(name),
          new Promise((r) => setTimeout(() => r(false), 120000)),
        ]);
        if (!approved) return this.reply(res, 403, { error: 'denied' });
        const newToken = crypto.randomBytes(32).toString('hex');
        this.settings.addBrowserClient(name, newToken);
        return this.reply(res, 200, { token: newToken });
      } finally {
        this.pairing = false;
      }
    }

    if (route === 'POST /v1/download') {
      if (!paired) return this.reply(res, 401, { error: 'not paired' });
      const body = await this.readBody(req).catch(() => null);
      if (!body || !isDownloadableUrl(body.url)) return this.reply(res, 400, { error: 'bad url' });
      await this.onDownload({
        url: body.url,
        filename: typeof body.filename === 'string' ? body.filename : '',
        referrer: isHttpUrl(body.referrer) ? body.referrer : '',
        cookies: typeof body.cookies === 'string' ? body.cookies : '',
        cookieList: cleanCookieList(body.cookieList),
        userAgent: typeof body.userAgent === 'string' ? body.userAgent.slice(0, 512) : '',
        fileSize: Number(body.fileSize) || 0,
        mime: typeof body.mime === 'string' ? body.mime : '',
        source: ['click', 'menu', 'media', 'page'].includes(body.source) ? body.source : 'click',
      });
      return this.reply(res, 200, { ok: true });
    }

    return this.reply(res, 404, { error: 'not found' });
  }
}

/** Cookies with their domains (for video sites / yt-dlp). Only plain fields, bounded size. */
function cleanCookieList(list) {
  if (!Array.isArray(list)) return [];
  const str = (v, max) => String(v ?? '').replace(/[\t\r\n\0]/g, '').slice(0, max);
  return list.slice(0, 300).map((c) => ({
    name: str(c.name, 256),
    value: str(c.value, 8192),
    domain: str(c.domain, 256),
    path: str(c.path || '/', 512),
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    hostOnly: !!c.hostOnly,
    expirationDate: Number(c.expirationDate) || 0,
  })).filter((c) => c.name && c.domain);
}

function isHttpUrl(s) {
  try {
    return ['http:', 'https:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
}

function isDownloadableUrl(s) {
  try {
    return ['http:', 'https:', 'ftp:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
}

module.exports = { BrowserBridge, PORT };

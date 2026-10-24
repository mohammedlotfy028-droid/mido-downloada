// App settings stored in settings.json. Site passwords are encrypted with Electron's
// safeStorage (Windows DPAPI, tied to the user account) and never sent to the UI.
const { safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

function defaults(downloadsDir) {
  return {
    lang: 'ar',
    theme: 'system',
    downloadDir: downloadsDir,
    split: 8, // default connections per download
    maxConcurrent: 3, // downloads running at the same time; the rest wait in the queue
    speedLimit: 0, // KB/s for all downloads together, 0 = unlimited
    categorize: true, // put files in Video/Music/... sub-folders
    autoRetry: true,
    retryMax: 5,
    clipboardWatch: true,
    notifications: true,
    closeToTray: true,
    proxy: '', // e.g. http://127.0.0.1:8080 or http://user:pass@host:port
    userAgent: '',
    logins: [], // [{ host, user, pass (encrypted, base64) }]
    browserEnabled: true, // accept links from the browser extension
    browserAsk: true, // show the "new download" dialog for links from the browser
    browserClients: [], // paired extensions: [{ id, name, tokenHash, pairedAt }]
    // Start downloads at `start`, pause them at `stop` (optional), on these days (0 = Sunday).
    schedule: { enabled: false, start: '02:00', stop: '08:00', days: [0, 1, 2, 3, 4, 5, 6] },
    afterDone: 'nothing', // when everything finished: 'nothing' | 'quit' | 'sleep' | 'shutdown'
    autoUpdate: true,
  };
}

const sha256 = (s) => require('crypto').createHash('sha256').update(s).digest('hex');

class Settings {
  constructor(dataDir, downloadsDir) {
    this.file = path.join(dataDir, 'settings.json');
    this.values = defaults(downloadsDir);
    try {
      Object.assign(this.values, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      /* first run */
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
  }

  /** Settings as the UI sees them (passwords and tokens left out). */
  forUi() {
    return {
      ...this.values,
      logins: this.values.logins.map((l) => ({ host: l.host, user: l.user, hasPassword: !!l.pass })),
      browserClients: this.values.browserClients.map(({ id, name, pairedAt }) => ({ id, name, pairedAt })),
    };
  }

  /** Remembers a newly paired browser extension. Only a hash of its token is stored. */
  addBrowserClient(name, token) {
    const id = require('crypto').randomBytes(6).toString('hex');
    this.values.browserClients.push({ id, name: String(name).slice(0, 80), tokenHash: sha256(token), pairedAt: Date.now() });
    this.save();
    return id;
  }

  /** True if this token belongs to a paired extension. */
  isValidBrowserToken(token) {
    if (!token) return false;
    const h = sha256(String(token));
    return this.values.browserClients.some((c) => c.tokenHash === h);
  }

  /** Applies a partial update coming from the UI. */
  update(patch) {
    const next = { ...patch };
    if (Array.isArray(patch.browserClients)) {
      // The UI can only remove paired browsers, never add or change them.
      const keep = new Set(patch.browserClients.map((c) => c.id));
      next.browserClients = this.values.browserClients.filter((c) => keep.has(c.id));
    }
    if (Array.isArray(patch.logins)) {
      next.logins = patch.logins
        .filter((l) => l.host && l.user)
        .map((l) => {
          const host = normalizeHost(l.host);
          const old = this.values.logins.find((o) => o.host === host && o.user === l.user);
          // Empty password field = keep the one we already have.
          const pass = l.pass ? encrypt(l.pass) : old ? old.pass : '';
          return { host, user: l.user, pass };
        });
    }
    if (patch.schedule) {
      const s = patch.schedule;
      const time = (v) => (/^\d{1,2}:\d{2}$/.test(String(v || '')) ? String(v) : '');
      next.schedule = {
        enabled: !!s.enabled,
        start: time(s.start) || '02:00',
        stop: time(s.stop),
        days: (Array.isArray(s.days) ? s.days : []).map(Number).filter((d) => d >= 0 && d <= 6),
      };
    }
    if ('afterDone' in patch && !['nothing', 'quit', 'sleep', 'shutdown'].includes(patch.afterDone)) {
      next.afterDone = 'nothing';
    }
    for (const k of ['split', 'maxConcurrent', 'speedLimit', 'retryMax']) {
      if (k in next) next[k] = Math.max(0, Math.round(Number(next[k]) || 0));
    }
    Object.assign(this.values, next);
    this.save();
    return this.forUi();
  }

  /** Username/password for a URL's host, if the user saved one. */
  loginFor(url) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
    // Exact host first, then parent domains (files.example.com -> example.com).
    const match = this.values.logins
      .filter((l) => host === l.host || host.endsWith(`.${l.host}`))
      .sort((a, b) => b.host.length - a.host.length)[0];
    return match ? { user: match.user, pass: decrypt(match.pass) } : null;
  }

  /** aria2 global options derived from the settings. */
  aria2Options() {
    const v = this.values;
    return {
      'max-concurrent-downloads': String(Math.max(1, v.maxConcurrent || 1)),
      'max-overall-download-limit': v.speedLimit > 0 ? `${v.speedLimit}K` : '0',
      'all-proxy': v.proxy || '',
      'user-agent': v.userAgent || 'Mido-Download/0.5',
    };
  }
}

function normalizeHost(h) {
  const s = String(h).trim().toLowerCase();
  try {
    return new URL(s.includes('://') ? s : `http://${s}`).hostname;
  } catch {
    return s;
  }
}

function encrypt(text) {
  if (!safeStorage.isEncryptionAvailable()) return `plain:${Buffer.from(text).toString('base64')}`;
  return safeStorage.encryptString(text).toString('base64');
}

function decrypt(stored) {
  if (!stored) return '';
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString();
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    return '';
  }
}

module.exports = { Settings, encrypt, decrypt };

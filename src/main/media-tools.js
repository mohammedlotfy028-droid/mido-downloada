// Where yt-dlp and ffmpeg live, and keeping yt-dlp up to date.
//
// The installer ships a copy of yt-dlp next to the app (read-only in Program Files).
// We run it from a copy in the user's data folder so it can be updated: video sites change
// often and an old yt-dlp quickly stops working. Updates come from the official GitHub
// release and are checked against the SHA-256 list yt-dlp publishes with it.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RELEASE_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const ZIP_NAME = 'yt-dlp_win.zip';

/** "2026.10.21" / "2026.10.21.1" -> comparable number array */
const ver = (v) => String(v || '0').trim().split('.').map((n) => Number(n) || 0);
function newer(a, b) {
  const x = ver(a);
  const y = ver(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

const run = (exe, args) =>
  new Promise((resolve, reject) =>
    execFile(exe, args, { windowsHide: true, timeout: 60000 }, (err, out) => (err ? reject(err) : resolve(String(out).trim())))
  );

class MediaTools {
  /**
   * @param {object} o
   * @param {string} o.resourcesDir folder with yt-dlp/ and ffmpeg/ (shipped with the app)
   * @param {string} o.dataDir      the user's data folder
   */
  constructor({ resourcesDir, dataDir }) {
    this.bundledDir = path.join(resourcesDir, 'yt-dlp');
    this.ffmpegDir = path.join(resourcesDir, 'ffmpeg');
    this.toolsDir = path.join(dataDir, 'tools');
    this.workDir = path.join(this.toolsDir, 'yt-dlp');
    this.stateFile = path.join(this.toolsDir, 'state.json');
    this.status = { state: 'idle', version: '' };
  }

  paths() {
    const exe = path.join(this.workDir, 'yt-dlp.exe');
    return {
      ytdlp: fs.existsSync(exe) ? exe : path.join(this.bundledDir, 'yt-dlp.exe'),
      ffmpegDir: this.ffmpegDir,
    };
  }

  available() {
    return fs.existsSync(this.paths().ytdlp) && fs.existsSync(path.join(this.ffmpegDir, 'ffmpeg.exe'));
  }

  readVersion(dir) {
    try {
      return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim();
    } catch {
      return '';
    }
  }

  /** Makes sure the updatable copy exists and isn't older than the one shipped with the app. */
  async prepare() {
    if (!fs.existsSync(path.join(this.bundledDir, 'yt-dlp.exe'))) return;
    let bundled = this.readVersion(this.bundledDir);
    if (!bundled) bundled = await run(path.join(this.bundledDir, 'yt-dlp.exe'), ['--version']).catch(() => '');
    const current = this.readVersion(this.workDir);
    if (!fs.existsSync(path.join(this.workDir, 'yt-dlp.exe')) || newer(bundled, current)) {
      fs.mkdirSync(this.toolsDir, { recursive: true });
      this.swapIn(this.bundledDir, bundled, { copy: true });
    }
    this.status.version = this.readVersion(this.workDir);
  }

  /** Puts a new yt-dlp folder in place (old one is kept until the new one is there). */
  swapIn(fromDir, version, { copy = false } = {}) {
    const next = `${this.workDir}.new`;
    const old = `${this.workDir}.old`;
    fs.rmSync(next, { recursive: true, force: true });
    if (copy) fs.cpSync(fromDir, next, { recursive: true });
    else fs.renameSync(fromDir, next);
    fs.writeFileSync(path.join(next, 'VERSION'), `${version}\n`);
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(this.workDir)) fs.renameSync(this.workDir, old);
    fs.renameSync(next, this.workDir);
    fs.rmSync(old, { recursive: true, force: true });
  }

  /**
   * Checks GitHub for a newer yt-dlp and installs it.
   * @param {() => boolean} isBusy  true while videos are downloading (we don't swap then)
   * @returns {Promise<string>} 'latest' | 'updated' | 'busy' | 'error: …'
   */
  async update(isBusy = () => false) {
    const state = (() => {
      try {
        return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      } catch {
        return {};
      }
    })();
    try {
      this.status.state = 'checking';
      const rel = await (await fetch(process.env.MIDO_YTDLP_RELEASE_API || RELEASE_API, { headers: { 'User-Agent': 'Mido-Download' } })).json();
      const latest = rel.tag_name;
      const current = this.readVersion(this.workDir);
      fs.mkdirSync(this.toolsDir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ ...state, checkedAt: Date.now(), latest }));
      if (!latest || !newer(latest, current)) return (this.status.state = 'latest');
      if (isBusy()) return (this.status.state = 'busy');

      const asset = (rel.assets || []).find((a) => a.name === ZIP_NAME);
      const sums = (rel.assets || []).find((a) => a.name === 'SHA2-256SUMS');
      if (!asset || !sums) throw new Error('release files not found');
      const zip = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
      const sumText = await (await fetch(sums.browser_download_url)).text();
      const expected = (sumText.split('\n').find((l) => l.trim().endsWith(ZIP_NAME)) || '').split(/\s+/)[0];
      const actual = crypto.createHash('sha256').update(zip).digest('hex');
      if (!expected || expected.toLowerCase() !== actual) throw new Error('downloaded file failed the SHA-256 check');

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-ytdlp-'));
      fs.writeFileSync(path.join(tmp, ZIP_NAME), zip);
      const out = path.join(tmp, 'out');
      fs.mkdirSync(out);
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      await run(tar, ['-xf', path.join(tmp, ZIP_NAME), '-C', out]);
      const v = await run(path.join(out, 'yt-dlp.exe'), ['--version']); // make sure it runs
      this.swapIn(out, v);
      fs.rmSync(tmp, { recursive: true, force: true });
      this.status.version = v;
      console.log(`[yt-dlp] updated ${current} -> ${v}`);
      return (this.status.state = 'updated');
    } catch (e) {
      console.error('[yt-dlp] update failed:', e.message);
      return (this.status.state = `error: ${e.message}`);
    }
  }

  /** Update at most once a day. */
  async updateIfDue(isBusy) {
    let checkedAt = 0;
    try {
      checkedAt = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')).checkedAt || 0;
    } catch {}
    if (Date.now() - checkedAt < 24 * 60 * 60 * 1000) return 'not due';
    return this.update(isBusy);
  }
}

module.exports = { MediaTools, newer };

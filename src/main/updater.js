// Automatic updates from GitHub Releases (electron-updater).
// The new version is downloaded in the background; the user picks when to restart.
const { app } = require('electron');
const pkg = require('../../package.json');

const PLACEHOLDER_OWNER = 'CHANGE-ME';

class Updater {
  /** @param {(status:object) => void} onStatus  sends the state to the UI */
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.status = { state: 'idle', version: app.getVersion() };
    this.updater = null;
    this.timer = null;
    const owner = ((pkg.build && pkg.build.publish) || [])[0]?.owner;
    const feed = process.env.MIDO_UPDATE_URL; // tests: a local server instead of GitHub
    // Only an installed copy can update itself, and only once the GitHub repo is set.
    this.enabled = (app.isPackaged && owner && owner !== PLACEHOLDER_OWNER) || !!feed;
    if (!this.enabled) {
      this.set({ state: 'unavailable' });
      return;
    }
    const { autoUpdater } = require('electron-updater');
    this.updater = autoUpdater;
    if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // also installs on the next normal quit
    autoUpdater.logger = { info() {}, warn: console.warn, error: console.error, debug() {} };
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ state: 'latest' }));
    autoUpdater.on('update-available', (i) => this.set({ state: 'downloading', newVersion: i.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (i) => this.set({ state: 'ready', newVersion: i.version }));
    autoUpdater.on('error', (e) => this.set({ state: 'error', error: String((e && e.message) || e).split('\n')[0] }));
  }

  set(patch) {
    this.status = { ...this.status, ...patch };
    console.log(`[update] ${this.status.state}${this.status.newVersion ? ` ${this.status.newVersion}` : ''}${this.status.error ? `: ${this.status.error}` : ''}`);
    this.onStatus(this.status);
  }

  async check() {
    if (!this.updater) return this.status;
    try {
      await this.updater.checkForUpdates();
    } catch (e) {
      this.set({ state: 'error', error: String(e.message || e).split('\n')[0] });
    }
    return this.status;
  }

  /** Check now and then every 6 hours. */
  startAutomatic() {
    if (!this.updater || this.timer) return;
    setTimeout(() => this.check(), 10000); // not right at startup
    this.timer = setInterval(() => this.check(), 6 * 60 * 60 * 1000);
  }

  stopAutomatic() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Quits and runs the downloaded installer. */
  installNow() {
    if (this.updater && this.status.state === 'ready') this.updater.quitAndInstall(true, true);
  }
}

module.exports = { Updater };

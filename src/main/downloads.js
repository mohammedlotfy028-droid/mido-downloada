// Keeps our own list of downloads (downloads.json) on top of aria2.
// aria2 only remembers unfinished downloads, so completed/cancelled ones live here.
// Emits: 'complete' (item), 'failed' (item) when a download gives up for good.
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { retryDelay } = require('./retry-policy');

const KEYS = [
  'gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed',
  'connections', 'numPieces', 'errorCode', 'errorMessage', 'dir', 'files',
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function nameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    return last || new URL(url).hostname;
  } catch {
    return url;
  }
}

const limitValue = (kb) => (kb > 0 ? `${Math.round(kb)}K` : '0');

class DownloadManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./aria2').Aria2} o.aria2
   * @param {string} o.dataDir
   * @param {(url:string) => object} [o.extraOptions] per-download aria2 options (logins...)
   * @param {() => {autoRetry:boolean, retryMax:number}} [o.retrySettings]
   */
  constructor({ aria2, dataDir, extraOptions = () => ({}), retrySettings = () => ({ autoRetry: false }) }) {
    super();
    this.aria2 = aria2;
    this.extraOptions = extraOptions;
    this.retrySettings = retrySettings;
    this.file = path.join(dataDir, 'downloads.json');
    /** @type {Record<string, any>} gid -> item */
    this.items = readJson(this.file, {});
    this.retryTimers = new Map();
    this.dirty = false;
  }

  save() {
    if (!this.dirty) return;
    writeJsonAtomic(this.file, this.items);
    this.dirty = false;
  }

  /** Adds a new download. Returns the new gid. */
  async add({ url, dir, out, split, speedLimit = 0, category = null }) {
    // aria2 runs with --pause=true (see aria2.js), so new downloads must opt out.
    const opts = { dir, pause: 'false', ...this.extraOptions(url) };
    if (out) opts.out = out;
    if (split) {
      opts.split = String(split);
      opts['max-connection-per-server'] = String(Math.min(16, split));
    }
    if (speedLimit > 0) opts['max-download-limit'] = limitValue(speedLimit);
    const gid = await this.aria2.call('addUri', [url], opts);
    this.items[gid] = {
      gid, url, dir, out: out || '', split: split || 8, speedLimit, category,
      name: out || nameFromUrl(url),
      addedAt: Date.now(), status: 'waiting', retries: 0,
      totalLength: 0, completedLength: 0, downloadSpeed: 0,
    };
    this.dirty = true;
    this.save();
    return gid;
  }

  /**
   * Call once right after aria2 starts. Downloads restored from the session all start
   * paused and without logins (we strip those from the file). Put the logins back, then
   * continue the ones that were running when the app closed.
   */
  async restoreAfterStart() {
    const lastStatus = Object.fromEntries(Object.values(this.items).map((i) => [i.gid, i.status]));
    const waiting = await this.aria2.call('tellWaiting', 0, 1000, ['gid', 'status']);
    for (const s of waiting) {
      const item = this.items[s.gid];
      if (!item) continue;
      const login = this.extraOptions(item.url);
      if (Object.keys(login).length) await this.aria2.call('changeOption', s.gid, login);
      if (s.status === 'paused' && lastStatus[s.gid] !== 'paused') await this.aria2.call('unpause', s.gid);
    }
  }

  /** Asks aria2 for the live state of every download and merges it into our list. */
  async refresh() {
    const [active, waiting, stopped] = await Promise.all([
      this.aria2.call('tellActive', KEYS),
      this.aria2.call('tellWaiting', 0, 1000, KEYS),
      this.aria2.call('tellStopped', 0, 1000, KEYS),
    ]);
    const seen = new Set();
    waiting.forEach((s, i) => (s.queuePos = i + 1));
    for (const s of [...active, ...waiting, ...stopped]) {
      seen.add(s.gid);
      const item = this.items[s.gid];
      if (!item) continue; // added outside the app; ignore
      const filePath = s.files && s.files[0] && s.files[0].path;
      const prevStatus = item.status;
      const before = item.status + item.completedLength;
      // After a restart aria2 reports 0 bytes for paused downloads until they start
      // (it reads the .aria2 control file lazily), so keep our last known numbers.
      const lazy = s.status === 'paused' && Number(s.completedLength) === 0;
      Object.assign(item, {
        status: s.status,
        totalLength: lazy ? item.totalLength : Number(s.totalLength),
        completedLength: lazy ? item.completedLength : Number(s.completedLength),
        downloadSpeed: Number(s.downloadSpeed),
        connections: Number(s.connections || 0),
        queuePos: s.status === 'waiting' ? s.queuePos : 0,
        errorCode: s.errorCode,
        errorMessage: s.errorMessage,
      });
      if (filePath) {
        item.path = filePath;
        item.name = path.basename(filePath);
      }
      if (item.status === 'complete' && !item.completedAt) item.completedAt = Date.now();
      if (before !== item.status + item.completedLength) this.dirty = true;
      if (prevStatus !== item.status) this.onStatusChange(item, prevStatus);
    }
    // Items aria2 no longer knows about (e.g. finished in a previous run) keep their
    // last snapshot, but they can't be "downloading" anymore.
    for (const item of Object.values(this.items)) {
      if (!seen.has(item.gid)) {
        item.downloadSpeed = 0;
        if (['active', 'waiting', 'paused'].includes(item.status)) {
          item.status = 'removed';
          this.dirty = true;
        }
      }
    }
    this.save();
    return this.list();
  }

  onStatusChange(item, prevStatus) {
    if (item.status === 'complete') {
      item.retryAt = 0; // keep item.retries: it tells how many automatic retries it took
      this.emit('complete', item);
    } else if (item.status === 'error' && prevStatus !== 'error') {
      const delay = retryDelay(item.errorCode, item.retries || 0, this.retrySettings());
      if (delay === null) {
        item.retryAt = 0;
        this.emit('failed', item);
        return;
      }
      item.retryAt = Date.now() + delay;
      const gid = item.gid;
      this.retryTimers.set(
        gid,
        setTimeout(() => {
          this.retryTimers.delete(gid);
          const it = this.items[gid];
          if (it && it.status === 'error') this.resume(gid, { auto: true }).catch(() => {});
        }, delay)
      );
    }
  }

  clearRetry(gid) {
    clearTimeout(this.retryTimers.get(gid));
    this.retryTimers.delete(gid);
    if (this.items[gid]) this.items[gid].retryAt = 0;
  }

  list() {
    return Object.values(this.items).sort((a, b) => b.addedAt - a.addedAt);
  }

  async pause(gid) {
    await this.aria2.call('forcePause', gid);
  }

  async resume(gid, { auto = false } = {}) {
    const item = this.items[gid];
    if (!item) return;
    this.clearRetry(gid);
    if (item.status === 'paused') {
      await this.aria2.call('unpause', gid);
      return;
    }
    if (['removed', 'error'].includes(item.status)) {
      // aria2 can't restart a stopped download, so re-add it with the same file name.
      // --continue=true makes it pick up from the partial file + .aria2 control file.
      try {
        await this.aria2.call('removeDownloadResult', gid);
      } catch {}
      const out = item.path ? path.basename(item.path) : item.out;
      const newGid = await this.add({
        url: item.url, dir: item.dir, out, split: item.split,
        speedLimit: item.speedLimit, category: item.category,
      });
      Object.assign(this.items[newGid], {
        addedAt: item.addedAt,
        retries: auto ? (item.retries || 0) + 1 : 0,
      });
      delete this.items[gid];
      this.dirty = true;
      this.save();
    }
  }

  /** Stops the download but keeps it in the list (can be resumed later). */
  async cancel(gid) {
    this.clearRetry(gid);
    try {
      await this.aria2.call('forceRemove', gid);
    } catch {}
    // A failed download is already stopped; mark it cancelled so it won't auto-retry.
    const item = this.items[gid];
    if (item && item.status === 'error') {
      item.status = 'removed';
      this.dirty = true;
      this.save();
    }
  }

  /** Removes the download from the list. Returns the file paths that belonged to it. */
  async remove(gid) {
    this.clearRetry(gid);
    const item = this.items[gid];
    try {
      await this.aria2.call('forceRemove', gid);
    } catch {}
    try {
      await this.aria2.call('removeDownloadResult', gid);
    } catch {}
    delete this.items[gid];
    this.dirty = true;
    this.save();
    if (!item || !item.path) return [];
    return [item.path, `${item.path}.aria2`].filter((p) => fs.existsSync(p));
  }

  /** Per-download speed limit in KB/s (0 = unlimited). */
  async setSpeedLimit(gid, kb) {
    const item = this.items[gid];
    if (!item) return;
    item.speedLimit = Math.max(0, Number(kb) || 0);
    this.dirty = true;
    this.save();
    if (['active', 'waiting', 'paused'].includes(item.status)) {
      await this.aria2.call('changeOption', gid, { 'max-download-limit': limitValue(item.speedLimit) });
    }
  }

  /** Moves a queued download up (-1) or down (+1), or to the front ('top'). */
  async move(gid, how) {
    if (how === 'top') await this.aria2.call('changePosition', gid, 0, 'POS_SET');
    else await this.aria2.call('changePosition', gid, how, 'POS_CUR');
  }

  async pauseAll() {
    await this.aria2.call('forcePauseAll');
  }

  async resumeAll() {
    await this.aria2.call('unpauseAll');
  }
}

module.exports = { DownloadManager };

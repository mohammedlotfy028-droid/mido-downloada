// Keeps our own list of downloads (downloads.json) on top of aria2.
// aria2 only remembers unfinished downloads, so completed/cancelled ones live here.
const fs = require('fs');
const path = require('path');

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

class DownloadManager {
  constructor({ aria2, dataDir }) {
    this.aria2 = aria2;
    this.file = path.join(dataDir, 'downloads.json');
    /** @type {Record<string, any>} gid -> item */
    this.items = readJson(this.file, {});
    this.dirty = false;
  }

  save() {
    if (!this.dirty) return;
    writeJsonAtomic(this.file, this.items);
    this.dirty = false;
  }

  /** Adds a new download. Returns the new gid. */
  async add({ url, dir, out, split }) {
    const opts = { dir };
    if (out) opts.out = out;
    if (split) {
      opts.split = String(split);
      opts['max-connection-per-server'] = String(Math.min(16, split));
    }
    const gid = await this.aria2.call('addUri', [url], opts);
    this.items[gid] = {
      gid, url, dir, out: out || '', split: split || 8,
      name: out || nameFromUrl(url),
      addedAt: Date.now(), status: 'waiting',
      totalLength: 0, completedLength: 0, downloadSpeed: 0,
    };
    this.dirty = true;
    this.save();
    return gid;
  }

  /** Asks aria2 for the live state of every download and merges it into our list. */
  async refresh() {
    const [active, waiting, stopped] = await Promise.all([
      this.aria2.call('tellActive', KEYS),
      this.aria2.call('tellWaiting', 0, 1000, KEYS),
      this.aria2.call('tellStopped', 0, 1000, KEYS),
    ]);
    const seen = new Set();
    for (const s of [...active, ...waiting, ...stopped]) {
      seen.add(s.gid);
      const item = this.items[s.gid];
      if (!item) continue; // added outside the app; ignore
      const filePath = s.files && s.files[0] && s.files[0].path;
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
        errorCode: s.errorCode,
        errorMessage: s.errorMessage,
      });
      if (filePath) {
        item.path = filePath;
        item.name = path.basename(filePath);
      }
      if (item.status === 'complete' && !item.completedAt) item.completedAt = Date.now();
      if (before !== item.status + item.completedLength) this.dirty = true;
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

  list() {
    return Object.values(this.items).sort((a, b) => b.addedAt - a.addedAt);
  }

  async pause(gid) {
    await this.aria2.call('forcePause', gid);
  }

  async resume(gid) {
    const item = this.items[gid];
    if (!item) return;
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
      const newGid = await this.add({ url: item.url, dir: item.dir, out, split: item.split });
      Object.assign(this.items[newGid], { addedAt: item.addedAt });
      delete this.items[gid];
      this.dirty = true;
      this.save();
    }
  }

  /** Stops the download but keeps it in the list (can be resumed later). */
  async cancel(gid) {
    try {
      await this.aria2.call('forceRemove', gid);
    } catch {}
  }

  /** Removes the download from the list. Returns the file paths that belonged to it. */
  async remove(gid) {
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

  async pauseAll() {
    await this.aria2.call('forcePauseAll');
  }

  async resumeAll() {
    await this.aria2.call('unpauseAll');
  }
}

module.exports = { DownloadManager };

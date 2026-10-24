// Video downloads from YouTube / Facebook / Instagram / … through yt-dlp (+ ffmpeg to join
// the separate video and audio streams). Items look like aria2 items so the list, queue,
// notifications and "when done" logic treat them the same. Saved in media.json.
// Emits: 'complete' (item), 'failed' (item).
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { retryDelay } = require('./retry-policy');

// yt-dlp prints these with our templates; everything else on stdout is ignored.
const PROGRESS = 'download:MIDO_P %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.filename)s';

// Failures that retrying won't fix.
const PERMANENT = /private video|video unavailable|is not available|has been removed|copyright|sign in to confirm|login required|log in|not available in your country|members-only|unsupported url|requested format is not available|http error 404|this content isn.t available|playlist/i;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The file-name prefix of a playlist video ("03 - "), limited to characters that are safe in a yt-dlp template. */
const cleanPrefix = (p) => String(p || '').replace(/[^\w .()\-]/g, '');

/**
 * The finished file of a video. yt-dlp's printed path can differ from the real file name
 * (it drops characters like ":" and quotes, while the file gets full-width look-alikes), so
 * when that path doesn't exist we look for "[<video id>]" in the folder instead.
 */
function findFinalFile(dir, id, prefix = '') {
  if (!id || id === 'NA') return '';
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return '';
  }
  const start = cleanPrefix(prefix);
  const found = names
    .filter((n) => n.includes(`[${id}]`) && n.startsWith(start) && !/\.(part|ytdl)$/i.test(n) && !/\.temp\./i.test(n) && !/\.f\d+\.[a-z0-9]+$/i.test(n))
    .map((n) => ({ file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return found.length ? found[0].file : '';
}

// Longer playlists are cut here (a 5,000-row list would be unusable and slow to start).
const MAX_PLAYLIST = 300;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Browser cookies -> Netscape cookies.txt (what yt-dlp reads). */
function netscapeCookies(list) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of list) {
    const domain = (c.hostOnly ? '' : '.') + String(c.domain || '').replace(/^\./, '');
    const clean = (s) => String(s ?? '').replace(/[\t\r\n]/g, '');
    lines.push([
      (c.httpOnly ? '#HttpOnly_' : '') + clean(domain),
      c.hostOnly ? 'FALSE' : 'TRUE',
      clean(c.path || '/'),
      c.secure ? 'TRUE' : 'FALSE',
      Math.floor(num(c.expirationDate)),
      clean(c.name),
      clean(c.value),
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

/** yt-dlp options for the chosen quality. */
function formatArgs(quality) {
  const q = quality || { type: 'video', height: 1080 };
  if (q.type === 'audio') {
    const fmt = q.format === 'm4a' ? 'm4a' : 'mp3';
    return ['-f', fmt === 'm4a' ? 'ba[ext=m4a]/ba/b' : 'ba/b', '-x', '--audio-format', fmt, '--audio-quality', '0'];
  }
  // Best video up to that height + best audio. Prefer H.264 + AAC in MP4 so the file plays
  // everywhere (resolution still comes first: above 1080p YouTube only has VP9/AV1).
  const sort = q.height ? `res:${q.height},vcodec:h264,acodec:aac,ext:mp4:m4a` : 'vcodec:h264,acodec:aac,ext:mp4:m4a';
  return ['-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', 'mp4'];
}

class MediaManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dataDir
   * @param {() => {ytdlp:string, ffmpegDir:string}} o.tools
   * @param {() => object} o.settings current settings values
   * @param {{encrypt:Function, decrypt:Function}} o.secrets
   */
  constructor({ dataDir, tools, settings, secrets }) {
    super();
    Object.assign(this, { dataDir, tools, settings, secrets });
    this.file = path.join(dataDir, 'media.json');
    this.cookieDir = path.join(dataDir, 'media-cookies');
    this.items = readJson(this.file, {});
    this.procs = new Map(); // gid -> child process
    this.stopReason = new Map(); // gid -> 'pause' | 'cancel' | 'remove' | 'quit' | 'restart'
    this.retryTimers = new Map();
    // Leftover cookie files from a crash: delete them.
    fs.rmSync(this.cookieDir, { recursive: true, force: true });
    // Downloads that were running when the app closed continue (like aria2's).
    for (const item of Object.values(this.items)) {
      if (item.status === 'active') item.status = 'waiting';
      item.downloadSpeed = 0;
    }
    this.save();
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // ---------- running yt-dlp ----------
  env() {
    return {
      ...process.env,
      // yt-dlp needs a JavaScript runtime for YouTube; Electron itself can act as Node.
      ELECTRON_RUN_AS_NODE: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    };
  }

  baseArgs() {
    const { ffmpegDir } = this.tools();
    const s = this.settings();
    const args = [
      '--ignore-config', // never pick up a yt-dlp config the user may have for other uses
      '--no-playlist',
      '--newline',
      '--no-colors',
      '--js-runtimes', `node:${process.execPath}`,
      '--ffmpeg-location', ffmpegDir,
      '--windows-filenames',
      '--no-mtime',
      '--retries', '10',
      '--fragment-retries', '20',
      '-N', '4', // download 4 pieces at a time
    ];
    if (s.proxy) args.push('--proxy', s.proxy);
    return args;
  }

  /** Cookie / User-Agent / Referer options; writes a temporary cookies file if needed. */
  requestArgs(secret, cookieFileName) {
    const args = [];
    let cookieFile = null;
    if (secret && secret.cookieList && secret.cookieList.length) {
      fs.mkdirSync(this.cookieDir, { recursive: true });
      cookieFile = path.join(this.cookieDir, `${cookieFileName}.txt`);
      fs.writeFileSync(cookieFile, netscapeCookies(secret.cookieList));
      args.push('--cookies', cookieFile);
    }
    const ua = (secret && secret.userAgent) || this.settings().userAgent;
    if (ua) args.push('--user-agent', ua);
    if (secret && secret.referrer) args.push('--referer', secret.referrer);
    return { args, cookieFile };
  }

  run(args, { onLine, timeout } = {}) {
    const child = spawn(this.tools().ytdlp, args, { env: this.env(), windowsHide: true });
    let buf = '';
    const err = [];
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (onLine) onLine(line);
      }
    });
    child.stderr.on('data', (d) => err.push(d.toString('utf8')));
    let timer = null;
    if (timeout) timer = setTimeout(() => killTree(child), timeout);
    const done = new Promise((resolve) =>
      child.on('close', (code) => {
        clearTimeout(timer);
        if (buf && onLine) onLine(buf);
        const stderr = err.join('');
        const lastError = (stderr.match(/^ERROR:.*$/gm) || []).pop() || '';
        resolve({ code, stderr, lastError: lastError.replace(/^ERROR:\s*/, '') });
      })
    );
    return { child, done };
  }

  // ---------- looking at a video before downloading ----------
  /**
   * @returns {Promise<{ok:boolean, error?:string, title?:string, thumbnail?:string, duration?:number,
   *   uploader?:string, site?:string, qualities?:Array<{id,label,height,size}>, hasAudio?:boolean}>}
   */
  async info(url, secret = null) {
    const name = `info-${crypto.randomBytes(6).toString('hex')}`;
    const { args, cookieFile } = this.requestArgs(secret, name);
    let out = '';
    const { done } = this.run([...this.baseArgs(), ...args, '-J', '--no-warnings', url], {
      onLine: (l) => (out += `${l}\n`),
      timeout: 90000,
    });
    const r = await done;
    if (cookieFile) fs.rmSync(cookieFile, { force: true });
    let j = null;
    try {
      j = JSON.parse(out);
    } catch {}
    // On errors yt-dlp prints "null" (valid JSON!) and the reason on stderr.
    if (!j || typeof j !== 'object') return { ok: false, error: r.lastError || `yt-dlp exited with code ${r.code}` };
    if (j._type === 'playlist') return { ok: false, error: 'PLAYLIST' };
    const formats = j.formats || [];
    // Estimate sizes with the same preferences formatArgs() gives yt-dlp: H.264 / AAC / MP4.
    const sizeOf = (f) => num(f && (f.filesize || f.filesize_approx));
    const audio = formats.filter((f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));
    const audioRank = (f) => (/^mp4a/.test(f.acodec) ? 2 : 0) + (f.ext === 'm4a' ? 1 : 0);
    const bestAudio = audio.sort((a, b) => audioRank(b) - audioRank(a) || num(b.abr) - num(a.abr))[0];
    // yt-dlp prefers direct (https) streams over HLS/DASH manifests, then our codec/container wishes.
    const direct = (f) => /^https?$/.test(f.protocol || 'https');
    const videoRank = (f) => (direct(f) ? 4 : 0) + (/^(avc|h264)/.test(f.vcodec) ? 2 : 0) + (f.ext === 'mp4' ? 1 : 0);
    const byHeight = new Map();
    for (const f of formats) {
      if (!f.height || !f.vcodec || f.vcodec === 'none') continue;
      const cur = byHeight.get(f.height);
      if (!cur || videoRank(f) > videoRank(cur) || (videoRank(f) === videoRank(cur) && num(f.tbr) > num(cur.tbr))) byHeight.set(f.height, f);
    }
    const qualities = [...byHeight.entries()]
      .sort((a, b) => b[0] - a[0])
      .filter(([h]) => h >= 144)
      .map(([h, f]) => {
        const separateAudio = f.acodec === 'none' || !f.acodec;
        const size = sizeOf(f) ? sizeOf(f) + (separateAudio ? sizeOf(bestAudio) : 0) : 0;
        return { id: `v${h}`, label: `${h}p`, height: h, size };
      });
    if (!qualities.length && formats.length) qualities.push({ id: 'best', label: 'best', height: 0, size: sizeOf(formats[formats.length - 1]) });
    return {
      ok: true,
      title: j.title || j.id || url,
      thumbnail: /^https:/.test(j.thumbnail || '') ? j.thumbnail : '',
      duration: num(j.duration),
      uploader: j.uploader || j.channel || '',
      site: j.extractor_key || '',
      isLive: !!j.is_live,
      qualities,
      hasAudio: !!bestAudio || formats.some((f) => f.acodec && f.acodec !== 'none'),
      audioSize: sizeOf(bestAudio),
    };
  }

  // ---------- playlists ----------
  /**
   * The videos of a playlist (titles and lengths only: "flat" extraction is fast, it doesn't
   * look inside each video). At most MAX_PLAYLIST videos.
   * @returns {Promise<{ok:boolean, error?:string, id?:string, title?:string, uploader?:string,
   *   total?:number, truncated?:boolean, entries?:Array<{id:string, title:string, duration:number, url:string, unavailable:boolean}>}>}
   */
  async playlist(url, secret = null) {
    const name = `pl-${crypto.randomBytes(6).toString('hex')}`;
    const { args, cookieFile } = this.requestArgs(secret, name);
    let out = '';
    const { done } = this.run(
      [...this.baseArgs(), ...args, '--yes-playlist', '--flat-playlist', '--playlist-end', String(MAX_PLAYLIST), '-J', '--no-warnings', url],
      { onLine: (l) => (out += `${l}\n`), timeout: 120000 }
    );
    const r = await done;
    if (cookieFile) fs.rmSync(cookieFile, { force: true });
    let j = null;
    try {
      j = JSON.parse(out);
    } catch {}
    if (!j || typeof j !== 'object') return { ok: false, error: r.lastError || `yt-dlp exited with code ${r.code}` };
    if (j._type !== 'playlist' || !Array.isArray(j.entries)) return { ok: false, error: 'NOT_PLAYLIST' };
    const entries = j.entries
      .filter((e) => e && e.id)
      .map((e) => ({
        id: String(e.id),
        title: e.title || e.id,
        duration: num(e.duration),
        url: /^https:/.test(e.url || '') ? e.url : `https://www.youtube.com/watch?v=${e.id}`,
        // Deleted / private videos still show up in the list, with a placeholder title.
        unavailable: /^\[(private|deleted) video\]$/i.test(e.title || '') || e.availability === 'private',
      }));
    const total = num(j.playlist_count) || entries.length;
    return {
      ok: true,
      id: String(j.id || ''),
      title: j.title || 'playlist',
      uploader: j.uploader || j.channel || '',
      total,
      truncated: total > entries.length,
      entries,
    };
  }

  /** Stops every unfinished video of the playlist this download belongs to. */
  async cancelPlaylist(gid) {
    const pl = this.items[gid] && this.items[gid].playlist;
    if (!pl) return;
    for (const item of Object.values(this.items)) {
      if (item.playlist && item.playlist.id === pl.id && ['waiting', 'active', 'paused', 'error'].includes(item.status)) {
        await this.cancel(item.gid);
      }
    }
  }

  /** True while any video of that playlist is still waiting, downloading or about to be retried. */
  playlistBusy(playlistId) {
    return Object.values(this.items).some(
      (i) => i.playlist && i.playlist.id === playlistId && (['waiting', 'active', 'paused'].includes(i.status) || (i.status === 'error' && i.retryAt > Date.now()))
    );
  }

  /** Counts of a playlist's videos by outcome (for the "playlist finished" notification). */
  playlistSummary(playlistId) {
    const items = Object.values(this.items).filter((i) => i.playlist && i.playlist.id === playlistId);
    const count = (s) => items.filter((i) => i.status === s).length;
    return { total: items.length, complete: count('complete'), failed: count('error'), cancelled: count('removed'), title: items[0] && items[0].playlist.title };
  }

  // ---------- the download list ----------
  /**
   * @param {object} o
   * @param {{type:'video', height:number}|{type:'audio', format:'mp3'|'m4a'}} o.quality
   * @param {{cookieList?:object[], userAgent?:string, referrer?:string}} [o.secret]
   * @param {{id:string, title:string, index:number, total:number}} [o.playlist] set for videos added from a playlist
   * @param {number} [o.addedAt] playlist videos share one time, so they keep their order in the list
   */
  add({ secret = null, ...o }) {
    const gid = this.makeItem(o, secret ? this.secrets.encrypt(JSON.stringify(secret)) : '');
    this.save();
    this.schedule();
    return gid;
  }

  makeItem({ url, dir, quality, title = '', size = 0, category = null, speedLimit = 0, playlist = null, outPrefix = '', addedAt = Date.now() }, encryptedSecret) {
    const gid = `m${crypto.randomBytes(8).toString('hex').slice(0, 15)}`;
    this.items[gid] = {
      gid, kind: 'media', url, dir, quality, category, speedLimit, playlist, outPrefix,
      name: title || url, title,
      secret: encryptedSecret,
      status: 'waiting', addedAt, retries: 0,
      totalLength: size, completedLength: 0, downloadSpeed: 0,
      stage: '', streams: {}, partFiles: [],
    };
    return gid;
  }

  /**
   * Adds the chosen videos of a playlist in one go (one save, one encrypted copy of the cookies).
   * @param {object} o
   * @param {{id:string, title:string, total:number}} o.playlist
   * @param {Array<{url:string, title:string, index:number}>} o.entries index = position in the playlist (1-based)
   * @param {boolean} o.numbered put the position in front of each file name ("03 - Title")
   * @returns {string[]} the new gids, in playlist order
   */
  addPlaylist({ playlist, entries, dir, quality, speedLimit = 0, category = null, secret = null, numbered = true }) {
    const encrypted = secret ? this.secrets.encrypt(JSON.stringify(secret)) : '';
    const now = Date.now(); // same time for all: they keep playlist order in the list and in the queue
    const width = Math.max(2, String(playlist.total || entries.length).length);
    const gids = entries.map((e) =>
      this.makeItem({
        url: e.url, dir, quality, title: e.title, category, speedLimit, addedAt: now,
        playlist: { id: playlist.id, title: playlist.title, index: e.index, total: playlist.total || entries.length },
        outPrefix: numbered ? `${String(e.index).padStart(width, '0')} - ` : '',
      }, encrypted)
    );
    this.save();
    this.schedule();
    return gids;
  }

  secretOf(item) {
    if (!item.secret) return null;
    try {
      return JSON.parse(this.secrets.decrypt(item.secret));
    } catch {
      return null;
    }
  }

  list() {
    return Object.values(this.items).map(({ secret, streams, partFiles, ...rest }) => ({ ...rest, fromBrowser: !!secret }));
  }

  /** Starts waiting downloads, at most 2 at a time (video sites dislike more). */
  schedule() {
    const limit = Math.max(1, Math.min(2, this.settings().maxConcurrent || 1));
    let running = Object.values(this.items).filter((i) => i.status === 'active').length;
    const waiting = Object.values(this.items)
      .filter((i) => i.status === 'waiting')
      .sort((a, b) => a.addedAt - b.addedAt);
    for (const item of waiting) {
      if (running >= limit) break;
      this.start(item);
      running++;
    }
    let pos = 0;
    for (const item of waiting) if (item.status === 'waiting') item.queuePos = ++pos;
  }

  start(item) {
    Object.assign(item, { status: 'active', downloadSpeed: 0, errorMessage: '', stage: 'starting', retryAt: 0, queuePos: 0 });
    item.streams = item.streams || {};
    const { args: reqArgs, cookieFile } = this.requestArgs(this.secretOf(item), item.gid);
    const args = [
      ...this.baseArgs(),
      ...formatArgs(item.quality),
      ...reqArgs,
      '-P', item.dir,
      // Playlist videos start with their number ("03 - …") so they sort in playlist order.
      '-o', `${cleanPrefix(item.outPrefix)}%(title).150B [%(id)s].%(ext)s`,
      '--progress', '--progress-template', PROGRESS,
      '--print', 'before_dl:MIDO_INFO %(format_id)s|%(id)s|%(title)s',
      '--print', 'after_move:MIDO_DONE %(filepath)s',
    ];
    if (item.speedLimit > 0) args.push('-r', `${Math.round(item.speedLimit)}K`);
    args.push(item.url);

    let finalPath = '';
    let videoId = '';
    let expectedStreams = 1;
    const { child, done } = this.run(args, {
      onLine: (line) => {
        if (line.startsWith('MIDO_INFO ')) {
          const [fmt, id, ...t] = line.slice(10).split('|');
          expectedStreams = fmt.split('+').length;
          item.expectedStreams = expectedStreams;
          videoId = id;
          const title = t.join('|');
          if (title && title !== 'NA') {
            item.title = title;
            item.name = title;
          }
        } else if (line.startsWith('MIDO_P ')) {
          const [status, downloaded, total, estimate, speed, , filename] = line.slice(7).split('|');
          if (!filename || filename === 'NA') return;
          const s = (item.streams[filename] = item.streams[filename] || { done: 0, total: 0 });
          if (!item.partFiles.includes(filename)) item.partFiles.push(filename);
          s.total = num(total) || num(estimate) || s.total;
          s.done = status === 'finished' ? s.total || num(downloaded) : num(downloaded);
          const streams = Object.values(item.streams);
          item.completedLength = streams.reduce((a, x) => a + x.done, 0);
          const seenTotal = streams.reduce((a, x) => a + x.total, 0);
          item.totalLength = Math.max(seenTotal, streams.length < expectedStreams ? item.totalLength : 0);
          item.downloadSpeed = status === 'finished' ? 0 : num(speed);
          item.stageIndex = Object.keys(item.streams).indexOf(filename) + 1;
          const allDone = streams.length >= expectedStreams && streams.every((x) => x.done >= x.total && x.total > 0);
          item.stage = allDone ? (item.quality && item.quality.type === 'audio' ? 'convert' : 'merge') : 'download';
        } else if (line.startsWith('MIDO_DONE ')) {
          finalPath = line.slice(10).trim();
        }
      },
    });
    this.procs.set(item.gid, child);
    this.save();

    done.then(({ code, lastError }) => {
      this.procs.delete(item.gid);
      if (cookieFile) fs.rmSync(cookieFile, { force: true });
      const reason = this.stopReason.get(item.gid);
      this.stopReason.delete(item.gid);
      if (!this.items[item.gid]) return this.schedule(); // removed meanwhile
      item.downloadSpeed = 0;
      if (reason === 'pause') item.status = 'paused';
      else if (reason === 'cancel') item.status = 'removed';
      else if (reason === 'quit') item.status = 'waiting'; // continue on next start
      else if (reason === 'restart') item.status = 'waiting';
      else if (code === 0 && (finalPath = (finalPath && fs.existsSync(finalPath) ? finalPath : findFinalFile(item.dir, videoId, item.outPrefix)))) {
        const size = fs.statSync(finalPath).size;
        Object.assign(item, { status: 'complete', path: finalPath, name: path.basename(finalPath), totalLength: size, completedLength: size, stage: '', completedAt: Date.now() });
        this.emit('complete', item);
      } else {
        this.failed(item, lastError || `yt-dlp exited with code ${code}`);
      }
      this.save();
      if (reason !== 'quit') this.schedule();
    });
  }

  failed(item, message) {
    Object.assign(item, { status: 'error', errorMessage: message, stage: '' });
    const delay = PERMANENT.test(message) ? null : retryDelay('media', item.retries || 0, this.settings());
    if (delay === null) {
      item.retryAt = 0;
      this.emit('failed', item);
      return;
    }
    item.retryAt = Date.now() + delay;
    const gid = item.gid;
    this.retryTimers.set(gid, setTimeout(() => {
      this.retryTimers.delete(gid);
      const it = this.items[gid];
      if (!it || it.status !== 'error') return;
      it.retries = (it.retries || 0) + 1;
      it.status = 'waiting';
      this.save();
      this.schedule();
    }, delay));
  }

  stopProcess(gid, reason) {
    const child = this.procs.get(gid);
    if (!child) return false;
    this.stopReason.set(gid, reason);
    killTree(child);
    return true;
  }

  clearRetry(gid) {
    clearTimeout(this.retryTimers.get(gid));
    this.retryTimers.delete(gid);
  }

  // ---------- actions (same names as DownloadManager) ----------
  async pause(gid) {
    const item = this.items[gid];
    if (!item) return;
    if (!this.stopProcess(gid, 'pause') && item.status === 'waiting') item.status = 'paused';
    this.save();
  }

  async resume(gid) {
    const item = this.items[gid];
    if (!item || ['active', 'waiting', 'complete'].includes(item.status)) return;
    this.clearRetry(gid);
    Object.assign(item, { status: 'waiting', retries: 0, retryAt: 0, errorMessage: '' });
    this.save();
    this.schedule();
  }

  async cancel(gid) {
    const item = this.items[gid];
    if (!item) return;
    this.clearRetry(gid);
    if (!this.stopProcess(gid, 'cancel')) item.status = 'removed';
    this.save();
  }

  /** Removes from the list. Returns the files (finished or partial) that belonged to it. */
  async remove(gid) {
    const item = this.items[gid];
    if (!item) return [];
    this.clearRetry(gid);
    const child = this.procs.get(gid);
    if (child) {
      this.stopReason.set(gid, 'remove');
      killTree(child);
      await new Promise((r) => child.once('close', r));
    }
    delete this.items[gid];
    this.save();
    const files = [];
    if (item.path) files.push(item.path);
    for (const f of item.partFiles || []) files.push(f, `${f}.part`, `${f}.ytdl`);
    return [...new Set(files)].filter((f) => fs.existsSync(f));
  }

  async setSpeedLimit(gid, kb) {
    const item = this.items[gid];
    if (!item) return;
    item.speedLimit = Math.max(0, Number(kb) || 0);
    this.save();
    // yt-dlp can't change its limit while running: restart it (it continues where it was).
    if (this.procs.has(gid)) this.stopProcess(gid, 'restart');
  }

  async pauseAll() {
    for (const item of Object.values(this.items)) {
      if (item.status === 'active') this.stopProcess(item.gid, 'pause');
      else if (item.status === 'waiting') item.status = 'paused';
    }
    this.save();
  }

  async resumeAll() {
    for (const item of Object.values(this.items)) {
      if (item.status === 'paused') item.status = 'waiting';
    }
    this.save();
    this.schedule();
  }

  /** App is closing: stop yt-dlp; running downloads continue next time. */
  async stopAll() {
    const running = [...this.procs.entries()];
    for (const [gid, child] of running) {
      this.stopReason.set(gid, 'quit');
      killTree(child);
    }
    await Promise.all(running.map(([, c]) => new Promise((r) => (c.exitCode !== null ? r() : c.once('close', r)))));
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.save();
  }
}

/** yt-dlp starts ffmpeg as a child: stop the whole tree. */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
}

module.exports = { MediaManager, netscapeCookies, formatArgs, findFinalFile };

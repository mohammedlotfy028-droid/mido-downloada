// Runs aria2c as a background process and talks to it over JSON-RPC (HTTP on 127.0.0.1).
// This file has no Electron dependency so it can be tested with plain Node.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Aria2 {
  /**
   * @param {object} opts
   * @param {string} opts.binPath    full path to aria2c.exe
   * @param {string} opts.dataDir    folder for the session file
   * @param {number} [opts.parentPid] aria2 exits by itself if this process dies
   */
  constructor({ binPath, dataDir, parentPid }) {
    this.binPath = binPath;
    this.dataDir = dataDir;
    this.parentPid = parentPid || process.pid;
    this.sessionFile = path.join(dataDir, 'aria2.session');
    this.secret = crypto.randomBytes(16).toString('hex');
    this.proc = null;
    this.port = null;
    this.rpcId = 0;
  }

  async start(globalOptions = {}) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.sessionFile)) fs.writeFileSync(this.sessionFile, '');
    stripSecrets(this.sessionFile); // in case the app crashed before cleaning it
    this.port = await getFreePort();

    const args = [
      '--enable-rpc=true',
      `--rpc-listen-port=${this.port}`,
      '--rpc-listen-all=false',
      `--rpc-secret=${this.secret}`,
      `--stop-with-process=${this.parentPid}`,
      // Resume after the app is closed: reload unfinished downloads from the session.
      `--input-file=${this.sessionFile}`,
      `--save-session=${this.sessionFile}`,
      // No automatic session saving: aria2 writes site passwords into it as plain text,
      // so we save it ourselves (saveSession) and strip them right away.
      // Everything loaded from the session starts paused, so the app can put the
      // logins back (from its encrypted settings) before anything connects.
      '--pause=true',
      '--continue=true',
      // Survive network drops: retry forever, detect dead connections fast.
      '--max-tries=0',
      // Many home networks have local-only IPv6 (fdxx:: addresses). aria2 then tries IPv6,
      // gets "unreachable network" and with max-tries=0 retries forever. IPv4 works everywhere.
      '--disable-ipv6=true',
      '--retry-wait=5',
      '--timeout=20',
      '--connect-timeout=15',
      // Segmented download defaults.
      '--split=8',
      '--max-connection-per-server=16',
      '--min-split-size=1M',
      '--max-concurrent-downloads=5',
      // falloc needs admin rights on Windows; trunc is instant and works without them.
      '--file-allocation=trunc',
      '--disk-cache=32M',
      '--auto-file-renaming=true',
      '--console-log-level=warn',
      '--summary-interval=0',
      '--show-console-readout=false',
      '--quiet=false',
    ];
    // User options replace the defaults above instead of appearing twice.
    const overridden = new Set(Object.keys(globalOptions));
    const finalArgs = args.filter((a) => !overridden.has(a.slice(2).split('=')[0]));
    for (const [k, v] of Object.entries(globalOptions)) {
      if (v !== undefined && v !== null && v !== '') finalArgs.push(`--${k}=${v}`);
    }

    this.proc = spawn(this.binPath, finalArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = (d) => {
      const text = String(d).trim();
      if (text) console.log(`[aria2] ${text}`);
    };
    this.proc.stdout.on('data', log);
    this.proc.stderr.on('data', log);
    const exited = new Promise((resolve) => this.proc.once('exit', resolve));
    this.proc.once('exit', (code) => {
      console.log(`[aria2] exited with code ${code}`);
      this.proc = null;
    });

    // Wait until the RPC server answers.
    for (let i = 0; i < 50; i++) {
      if (!this.proc) throw new Error(`aria2 exited during startup (code ${await exited})`);
      try {
        await this.call('getVersion');
        return;
      } catch {
        await sleep(100);
      }
    }
    throw new Error('aria2 RPC did not become ready');
  }

  async call(method, ...params) {
    const res = await fetch(`http://127.0.0.1:${this.port}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.rpcId,
        method: `aria2.${method}`,
        params: [`token:${this.secret}`, ...params],
      }),
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message);
    return json.result;
  }

  /** Saves unfinished downloads to the session file, without usernames/passwords. */
  async saveSession() {
    await this.call('saveSession');
    stripSecrets(this.sessionFile);
  }

  /** Saves the session and shuts aria2 down; kills it if it doesn't exit in time. */
  async stop() {
    if (!this.proc) return;
    try {
      await this._shutdown();
    } finally {
      stripSecrets(this.sessionFile); // aria2 rewrites the session while exiting
    }
  }

  async _shutdown() {
    const proc = this.proc;
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    try {
      await this.call('saveSession');
      await this.call('shutdown');
    } catch {
      /* already dead or not responding */
    }
    const timeout = sleep(4000).then(() => 'timeout');
    if ((await Promise.race([exited, timeout])) === 'timeout') {
      try {
        await this.call('forceShutdown');
      } catch {}
      if ((await Promise.race([exited, sleep(2000).then(() => 'timeout')])) === 'timeout') proc.kill();
    }
  }
}

/** Removes login lines (http-user, http-passwd, ftp-user, ftp-passwd) from a session file. */
function stripSecrets(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const clean = text.replace(/^[ \t]+(?:http|ftp)-(?:user|passwd)=.*(?:\r?\n|$)/gm, '');
  if (clean !== text) fs.writeFileSync(file, clean);
}

module.exports = { Aria2, stripSecrets };

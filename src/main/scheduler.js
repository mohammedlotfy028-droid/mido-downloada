// Download schedule (start / stop at set times on chosen days) and
// "when all downloads finish: quit / sleep / shut down".
const { spawn } = require('child_process');

/** "HH:MM" -> minutes since midnight, or null. */
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Is `now` inside the download window?
 * @param {Date} now
 * @param {{start:string, stop:string, days:number[]}} s  days: 0 = Sunday … 6 = Saturday
 *        stop may be empty: then the window never closes once started that day.
 */
function isInsideWindow(now, { start, stop, days }) {
  const startMin = toMinutes(start);
  if (startMin === null) return false;
  const stopMin = toMinutes(stop);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const yesterday = (today + 6) % 7;
  const dayOk = (d) => !days || days.length === 0 || days.includes(d);

  // TODO(Mohammed): the tricky case is a window that crosses midnight, e.g. 23:00 -> 07:00.
  // Current rule: it belongs to the day it STARTS on, so "Friday 23:00 -> 07:00" also covers
  // Saturday 00:00-07:00 even if Saturday isn't ticked. Change it if you'd rather it didn't.
  if (stopMin === null) return dayOk(today) && nowMin >= startMin;
  if (startMin < stopMin) return dayOk(today) && nowMin >= startMin && nowMin < stopMin;
  if (startMin > stopMin) {
    return (dayOk(today) && nowMin >= startMin) || (dayOk(yesterday) && nowMin < stopMin);
  }
  return false; // start === stop: empty window
}

class Scheduler {
  /**
   * @param {object} o
   * @param {() => object} o.settings        current settings values
   * @param {() => Promise<void>} o.startAll
   * @param {() => Promise<void>} o.stopAll
   * @param {() => Date} [o.now]            injectable clock (tests)
   */
  constructor({ settings, startAll, stopAll, now = () => new Date() }) {
    Object.assign(this, { settings, startAll, stopAll, now });
    this.lastInside = null;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[schedule]', e.message)), 20000);
    this.tick().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Acts only when we cross the start or stop time (so manual changes in between stick). */
  async tick(now = this.now()) {
    const s = this.settings().schedule;
    if (!s || !s.enabled) {
      this.lastInside = null;
      return null;
    }
    const inside = isInsideWindow(now, s);
    if (inside !== this.lastInside) {
      if (inside) await this.startAll();
      else if (this.lastInside !== null && s.stop) await this.stopAll();
      this.lastInside = inside;
    }
    return inside;
  }
}

/** Runs the power action. MIDO_FAKE_POWER=1 only logs it (used by the tests). */
function powerAction(action) {
  if (process.env.MIDO_FAKE_POWER === '1') {
    console.log(`[power] ${action} (test mode, not really)`);
    return;
  }
  const win = process.env.SystemRoot || 'C:\\Windows';
  // Detached, so it survives our own exit (we quit cleanly right before shutting down).
  const run = (exe, args) => spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  // 15s grace so the app can finish closing; Windows shows its own "shutting down" notice.
  if (action === 'shutdown') run(`${win}\\System32\\shutdown.exe`, ['/s', '/t', '15']);
  if (action === 'sleep') run(`${win}\\System32\\rundll32.exe`, ['powrprof.dll,SetSuspendState', '0,1,0']);
}

module.exports = { Scheduler, isInsideWindow, toMinutes, powerAction };

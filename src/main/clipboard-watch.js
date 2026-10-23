// Checks the clipboard every second; when a new link to a file is copied, calls onLink(url).
// Note: since Electron 45 the clipboard API returns Promises.
const { clipboard } = require('electron');
const { looksLikeFileUrl } = require('../shared/categories');

const readText = async () => String((await clipboard.readText()) || '').trim();

class ClipboardWatcher {
  constructor(onLink) {
    this.onLink = onLink;
    this.timer = null;
    this.last = '';
    this.busy = false;
  }

  async start() {
    if (this.timer) return;
    // Whatever is in the clipboard already when watching starts is not "new".
    this.last = await readText().catch(() => '');
    this.timer = setInterval(() => this.check(), 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Call when the app itself puts text in the clipboard, so it isn't caught. */
  ignore(text) {
    this.last = String(text).trim();
  }

  async check() {
    if (this.busy) return;
    this.busy = true;
    try {
      const text = await readText();
      if (!text || text === this.last) return;
      this.last = text;
      // Only single links to files (…/movie.mp4, …/setup.exe), not every web page link.
      if (!/\s/.test(text) && looksLikeFileUrl(text)) this.onLink(text);
    } catch {
      /* clipboard busy (another app has it open); try again next tick */
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { ClipboardWatcher };

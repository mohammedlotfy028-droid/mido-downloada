// System tray icon with a small menu, and a tooltip showing the current speed.
const { Tray, Menu, nativeImage } = require('electron');

const LABELS = {
  ar: { show: 'إظهار Mido Download', add: 'تحميل جديد…', pauseAll: 'إيقاف الكل', resumeAll: 'استئناف الكل', quit: 'خروج', idle: 'مفيش تحميلات شغالة', active: (n, s) => `${n} شغال · ${s}` },
  en: { show: 'Show Mido Download', add: 'New download…', pauseAll: 'Pause all', resumeAll: 'Resume all', quit: 'Quit', idle: 'No active downloads', active: (n, s) => `${n} active · ${s}` },
};

function speedText(bps) {
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
}

class AppTray {
  /**
   * @param {object} o
   * @param {string} o.iconPath
   * @param {() => string} o.lang
   * @param {{show:Function, add:Function, pauseAll:Function, resumeAll:Function, quit:Function}} o.actions
   */
  constructor({ iconPath, lang, actions }) {
    this.lang = lang;
    this.actions = actions;
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16, quality: 'best' });
    this.tray = new Tray(icon);
    this.tray.on('click', () => actions.show());
    this.tooltip = '';
    this.buildMenu();
  }

  buildMenu() {
    const l = LABELS[this.lang()] || LABELS.en;
    const a = this.actions;
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: l.show, click: a.show },
        { label: l.add, click: a.add },
        { type: 'separator' },
        { label: l.resumeAll, click: a.resumeAll },
        { label: l.pauseAll, click: a.pauseAll },
        { type: 'separator' },
        { label: l.quit, click: a.quit },
      ])
    );
  }

  update(list) {
    const l = LABELS[this.lang()] || LABELS.en;
    const active = list.filter((d) => d.status === 'active');
    const speed = active.reduce((s, d) => s + d.downloadSpeed, 0);
    const text = `Mido Download\n${active.length ? l.active(active.length, speedText(speed)) : l.idle}`;
    if (text !== this.tooltip) {
      this.tooltip = text;
      this.tray.setToolTip(text);
    }
  }

  destroy() {
    this.tray.destroy();
  }
}

module.exports = { AppTray };

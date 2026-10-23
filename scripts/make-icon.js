// Renders the app icon (SVG below) to resources/icon.png (512px) using Electron.
// Run: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 512;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${SIZE}" height="${SIZE}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#19b8a1"/><stop offset="1" stop-color="#0a7f70"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#g)"/>
  <path d="M32 13v24m0 0-10-10m10 10 10-10" fill="none" stroke="#fff" stroke-width="5.5"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M17 42v4a4 4 0 0 0 4 4h22a4 4 0 0 0 4-4v-4" fill="none" stroke="#fff" stroke-width="5.5"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true,
    useContentSize: true, webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent">${SVG}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const out = path.join(__dirname, '..', 'resources', 'icon.png');
  const full = img.resize({ width: SIZE, height: SIZE });
  fs.writeFileSync(out, full.toPNG());
  console.log('saved', out, img.getSize());
  // Browser extension icons.
  const extDir = path.join(__dirname, '..', 'extension', 'icons');
  fs.mkdirSync(extDir, { recursive: true });
  for (const s of [16, 32, 48, 128]) {
    fs.writeFileSync(path.join(extDir, `${s}.png`), full.resize({ width: s, height: s, quality: 'best' }).toPNG());
  }
  console.log('saved extension icons in', extDir);
  app.quit();
});

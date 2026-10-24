# Mido Download

برنامج إدارة تحميلات مفتوح المصدر للويندوز، مبني على Electron ومحرك [aria2](https://aria2.github.io/).
An open-source download manager for Windows built on Electron and aria2.

Download: [latest release](https://github.com/mohammedlotfy028-droid/mido-downloada/releases/latest)

## Features (v0.4)
- Segmented downloads (1–16 connections, default 8)
- Pause / resume / cancel / remove (optionally to Recycle Bin), open file / folder
- Resumes after closing the app or a network drop; automatic retry with back-off on failures
- Download queue with a max number of simultaneous downloads; reorder from the right-click menu
- Speed limit for everything and per download
- Checks the link first (real name, size, type, resume support) and sorts files into
  Video / Music / Programs / Compressed / Documents folders
- System tray icon, notifications when a download finishes or fails
- Watches the clipboard for file links; drag & drop links on the window; Ctrl+V anywhere
- Settings: proxy, User-Agent, default folder, saved site logins (passwords encrypted with Windows DPAPI)
- Browser extension for Chrome / Edge (see below)
- BitTorrent: open or drop `.torrent` files, paste `magnet:` links (stops seeding when done)
- Checksums: give an MD5/SHA-1/SHA-256/SHA-512 when adding a download, or verify any finished file
- Schedule: start and stop downloads at set times on chosen days (works across midnight)
- When all downloads finish: quit, sleep or shut down the PC (after a 1-minute countdown you can cancel)
- Automatic updates from GitHub Releases (installed app only)
- Arabic (RTL) and English, light and dark themes

## Browser extension (Chrome / Edge)
The `extension/` folder (also installed next to the app: Settings → Browser → "Open extension folder").

1. Open `chrome://extensions` or `edge://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension` folder.
3. Click the extension icon → **Connect**, then click **Allow** in Mido Download.

What it does:
- Downloads you click in the browser go to the app (big files and known types; small ones stay in the browser).
- Right-click a link, video, audio or image → **Download with Mido Download**.
- Cookies and Referer are passed along, so files behind a login work.
- The popup lists videos/audio the page played (direct files; HLS/.m3u8 streams are not supported yet).

How it talks to the app: a local server on `127.0.0.1:47811` that only accepts requests from
browser extensions, and only after you approve the pairing. Cookies are stored encrypted and are
removed from aria2's session file.

## Run from source
```bash
npm install
npm run fetch-aria2   # downloads aria2c.exe from the official GitHub release
npm start
```

## Tests
```bash
node test/engine-test.js            # aria2 engine: segments, pause, restart, network drop
node test/ui-test.js <screenshotDir> [realUrl]   # phase 1 on the real app window
node test/phase2-test.js <screenshotDir>          # phase 2 features on the real app window
node test/phase3-test.js <screenshotDir>          # extension in a temporary Edge profile + the app
node test/phase4-test.js <screenshotDir>          # torrents (local tracker+seeder), checksums, schedule, fake shutdown
npm run dist && node test/update-test.js <dir>    # packaged app finds/downloads an update from a local server
node test/rename-test.js <screenshotDir>          # data from the old name (Mido Downloada) moves to the new folder
```

## Build the installer
```bash
npm run dist          # output in dist/
```

## Releasing (GitHub)
1. Bump `version` in `package.json`, commit, then tag and push:
   ```bash
   git tag v0.4.0
   git push origin main --tags
   ```
2. The **Release** workflow (`.github/workflows/release.yml`) builds the installer on Windows,
   publishes it with `latest.yml` (used by automatic updates) and attaches the extension as a zip.

The installer is not code-signed, so Windows SmartScreen may warn the first time ("More info" → "Run anyway").

## License
MIT — see [LICENSE](LICENSE). aria2 is GPLv2 and shipped as a separate executable; see [NOTICE](NOTICE).

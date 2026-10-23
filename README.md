# Mido Downloada

برنامج إدارة تحميلات مفتوح المصدر للويندوز، مبني على Electron ومحرك [aria2](https://aria2.github.io/).
An open-source download manager for Windows built on Electron and aria2.

## Features (v0.2)
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
- Arabic (RTL) and English, light and dark themes

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
```

## Build the installer
```bash
npm run dist          # output in dist/
```

## License
MIT — see [LICENSE](LICENSE). aria2 is GPLv2 and shipped as a separate executable; see [NOTICE](NOTICE).

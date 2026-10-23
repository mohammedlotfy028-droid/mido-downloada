# Mido Downloada

برنامج إدارة تحميلات مفتوح المصدر للويندوز، مبني على Electron ومحرك [aria2](https://aria2.github.io/).
An open-source download manager for Windows built on Electron and aria2.

## Features (v0.1)
- Segmented downloads (1–16 connections, default 8)
- Pause / resume / cancel / remove (optionally to Recycle Bin), open file / folder
- Resumes after closing the app or a network drop
- Arabic (RTL) and English, light and dark themes
- Paste a link anywhere in the window (Ctrl+V) to add it

## Run from source
```bash
npm install
npm run fetch-aria2   # downloads aria2c.exe from the official GitHub release
npm start
```

## Tests
```bash
node test/engine-test.js            # aria2 engine: segments, pause, restart, network drop
node test/ui-test.js <screenshotDir> [realUrl]   # drives the real app window
```

## Build the installer
```bash
npm run dist          # output in dist/
```

## License
MIT — see [LICENSE](LICENSE). aria2 is GPLv2 and shipped as a separate executable; see [NOTICE](NOTICE).

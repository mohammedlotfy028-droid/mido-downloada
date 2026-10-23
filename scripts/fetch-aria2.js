// Downloads the official aria2 Windows build from GitHub releases into resources/aria2/.
// aria2 is GPLv2 and is shipped as a separate executable (we don't link its code).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const VERSION = '1.37.0';
const ZIP_NAME = `aria2-${VERSION}-win-64bit-build1`;
const URL = `https://github.com/aria2/aria2/releases/download/release-${VERSION}/${ZIP_NAME}.zip`;
const DEST = path.join(__dirname, '..', 'resources', 'aria2');

async function main() {
  if (fs.existsSync(path.join(DEST, 'aria2c.exe'))) {
    console.log('aria2c.exe already present, skipping.');
    return;
  }
  console.log('Downloading', URL);
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Extract in a fresh temp dir, then copy only the files we need.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aria2-'));
  const zipPath = path.join(tmp, 'aria2.zip');
  fs.writeFileSync(zipPath, buf);
  // Use Windows' bundled bsdtar (Git Bash's GNU tar can't read zip / "C:" paths).
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-xf', zipPath, '-C', tmp]);

  fs.mkdirSync(DEST, { recursive: true });
  const src = path.join(tmp, ZIP_NAME);
  fs.copyFileSync(path.join(src, 'aria2c.exe'), path.join(DEST, 'aria2c.exe'));
  fs.copyFileSync(path.join(src, 'COPYING'), path.join(DEST, 'COPYING'));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('aria2c.exe saved to', DEST);
}

main().catch((e) => {
  console.error('Failed to fetch aria2:', e.message);
  process.exit(1);
});

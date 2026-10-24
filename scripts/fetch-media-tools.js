// Downloads the tools for YouTube / Facebook / Instagram videos into resources/:
//  - yt-dlp (Unlicense / public domain): finds the real video streams on those sites
//  - ffmpeg 8.1, LGPL "shared" build from BtbN (the Windows builds linked from ffmpeg.org):
//    joins the separate video + audio streams and converts audio to MP3
// Both run as separate programs (we never link their code), like aria2.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RES = path.join(__dirname, '..', 'resources');
// The "folder" build (not the one-file exe): it doesn't unpack itself to %TEMP% on every
// run, so stopping it (pause) leaves nothing behind, and it starts faster.
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_win.zip';
const FFMPEG_ZIP = 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1';
const FFMPEG_URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${FFMPEG_ZIP}.zip`;

// Windows' own bsdtar (Git Bash's GNU tar can't read zip files or "C:" paths).
const tarExe = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

async function download(url, file) {
  console.log('Downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function ytdlp() {
  const dir = path.join(RES, 'yt-dlp');
  const exe = path.join(dir, 'yt-dlp.exe');
  if (fs.existsSync(exe) && fs.existsSync(path.join(dir, '_internal'))) {
    return console.log('yt-dlp already present, skipping.');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-'));
  const zip = path.join(tmp, 'yt-dlp_win.zip');
  await download(YTDLP_URL, zip);
  execFileSync(tarExe(), ['-xf', zip, '-C', dir]);
  fs.rmSync(tmp, { recursive: true, force: true });
  const v = execFileSync(exe, ['--version']).toString().trim();
  fs.writeFileSync(path.join(dir, 'VERSION'), `${v}\n`); // read by the app (media-tools.js)
  console.log('yt-dlp', v);
}

async function ffmpeg() {
  const dir = path.join(RES, 'ffmpeg');
  if (fs.existsSync(path.join(dir, 'ffmpeg.exe'))) return console.log('ffmpeg.exe already present, skipping.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-'));
  const zip = path.join(tmp, 'ffmpeg.zip');
  await download(FFMPEG_URL, zip);
  execFileSync(tarExe(), ['-xf', zip, '-C', tmp]);
  const bin = path.join(tmp, FFMPEG_ZIP, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  // ffmpeg + ffprobe and the DLLs they share (ffplay is not needed).
  for (const f of fs.readdirSync(bin)) {
    if (f === 'ffplay.exe') continue;
    fs.copyFileSync(path.join(bin, f), path.join(dir, f));
  }
  fs.copyFileSync(path.join(tmp, FFMPEG_ZIP, 'LICENSE.txt'), path.join(dir, 'LICENSE.txt'));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(execFileSync(path.join(dir, 'ffmpeg.exe'), ['-version']).toString().split('\n')[0]);
}

(async () => {
  await ytdlp();
  await ffmpeg();
})().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});

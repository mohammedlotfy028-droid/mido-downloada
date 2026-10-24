// Unit tests (no app, no internet) for helpers of the video engine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { check } = require('./cdp');
const { findFinalFile, formatArgs, netscapeCookies } = require('../src/main/media');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mido-unit-'));
const touch = (name, ageMs = 0) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, 'x');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(f, t, t);
  return f;
};

// yt-dlp prints "13 - Caminandes 2 Gran Dillama [id].mp4" but the real file has full-width look-alikes.
const real = touch('13 - ＂Caminandes 2： Gran Dillama＂ - Short [Z4C82eyhwgU].mp4');
touch('13 - ＂Caminandes 2： Gran Dillama＂ - Short [Z4C82eyhwgU].f137.mp4');
touch('13 - ＂Caminandes 2： Gran Dillama＂ - Short [Z4C82eyhwgU].f140.m4a');
touch('13 - ＂Caminandes 2： Gran Dillama＂ - Short [Z4C82eyhwgU].mp4.part');
touch('13 - ＂Caminandes 2： Gran Dillama＂ - Short [Z4C82eyhwgU].temp.mp4');
touch('14 - Other [AAAAAAAAAAA].mp4');
const arabic = touch('05 - فيديو عربي： تجربة [abc123def45].mp3');

check(findFinalFile(dir, 'Z4C82eyhwgU', '13 - ') === real, 'finds the finished file when the printed name differs (: and quotes)');
check(findFinalFile(dir, 'Z4C82eyhwgU', '99 - ') === '', 'a different playlist number is not matched');
check(findFinalFile(dir, 'abc123def45', '05 - ') === arabic, 'finds a file with an Arabic title');
check(findFinalFile(dir, 'nope', '') === '' && findFinalFile(dir, 'NA', '') === '' && findFinalFile(dir, '', '') === '', 'unknown / empty ids give nothing');
check(findFinalFile(path.join(dir, 'missing'), 'Z4C82eyhwgU') === '', 'a missing folder gives nothing');
touch('Same [dupdupdup01].mp4', 60000);
const newer = touch('Same copy [dupdupdup01].mp4', 0);
check(findFinalFile(dir, 'dupdupdup01') === newer, 'if two files match, the newest one wins');

check(JSON.stringify(formatArgs({ type: 'audio', format: 'mp3' })).includes('--audio-format') && formatArgs({ type: 'video', height: 720 }).join(' ').includes('res:720'), 'quality options become the right yt-dlp arguments');
const cookies = netscapeCookies([{ name: 'a', value: 'b\tc\n', domain: '.youtube.com', path: '/', secure: true, httpOnly: true, hostOnly: false, expirationDate: 1.5 }]);
check(/^# Netscape HTTP Cookie File\n#HttpOnly_\.youtube\.com\tTRUE\t\/\tTRUE\t1\ta\tbc\n$/.test(cookies), 'cookies file format is right and tabs/newlines in values are stripped');

fs.rmSync(dir, { recursive: true, force: true });

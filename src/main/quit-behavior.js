// What happens to running downloads when the user closes the app?
//
// aria2 saves its session on shutdown either way, so nothing is lost. The question is
// only how they come back next time the app opens:
//   - leave them as they are -> they start downloading again automatically on next launch
//   - pause them             -> they wait in the list until the user presses "resume"
//
// @param {import('./downloads').DownloadManager} dm
// @param {Array<object>} running  downloads that are 'active' or 'waiting' right now
//                                 (each has gid, name, totalLength, completedLength, ...)
async function beforeAppClose(dm, running) {
  // TODO(Mohammed): pick the behaviour you want. Current default: do nothing, so running
  // downloads resume by themselves on the next launch (like most download managers).
  // Example alternative: pause everything so the next launch is quiet:
  //   for (const d of running) await dm.pause(d.gid);
}

module.exports = { beforeAppClose };

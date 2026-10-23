// When a download fails, should we try again by ourselves, and after how long?
//
// aria2 already retries network errors forever (--max-tries=0), so a download only reaches
// "error" when aria2 itself gave up: the server answered strangely, closed on us mid-way,
// refused too many connections, etc. Some failures will never fix themselves, though.
//
// aria2 error codes: https://aria2.github.io/manual/en/html/aria2c.html#exit-status
const PERMANENT = new Set([
  '3', // resource not found (404)
  '9', // not enough disk space
  '11', // same file is already being downloaded
  '13', // file already exists
  '15', // couldn't open existing file
  '16', // couldn't create / truncate file
  '18', // couldn't create directory
  '24', // HTTP authorization failed (wrong username/password)
  '28', // bad option
  '32', // checksum doesn't match (downloading again would give the same file)
]);

/**
 * @param {string} errorCode  aria2 error code of the failure
 * @param {number} attempt    how many automatic retries already happened (0 on the first failure)
 * @param {{autoRetry:boolean, retryMax:number}} settings
 * @returns {number|null}     milliseconds to wait before retrying, or null to give up
 */
function retryDelay(errorCode, attempt, settings) {
  if (!settings.autoRetry) return null;
  if (PERMANENT.has(String(errorCode))) return null;
  if (settings.retryMax > 0 && attempt >= settings.retryMax) return null;
  // TODO(Mohammed): this is the waiting curve. Current: 5s, 10s, 20s, 40s, then 60s max.
  // Shorter waits recover faster; longer ones are gentler on servers that rate-limit
  // (like proof.ovh.net, which blocked us after too many quick attempts).
  return Math.min(60000, 5000 * 2 ** attempt);
}

module.exports = { retryDelay, PERMANENT };

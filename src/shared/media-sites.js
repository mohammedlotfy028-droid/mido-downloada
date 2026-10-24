// Sites whose videos are not plain files: they go through yt-dlp instead of aria2.
// (yt-dlp supports many more; these are the ones we recognise automatically.)
const MEDIA_SITES = [
  { site: 'YouTube', hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], paths: /^\/(watch|shorts\/|live\/|embed\/|v\/|[A-Za-z0-9_-]{11}$)/ },
  { site: 'Facebook', hosts: ['facebook.com', 'fb.com'], paths: /(\/videos?\/|\/watch|\/reel\/|\/share\/[rv]\/)/ },
  { site: 'Facebook', hosts: ['fb.watch'], paths: /^\/[A-Za-z0-9_-]+\/?$/ },
  { site: 'Instagram', hosts: ['instagram.com'], paths: /^\/(p|reel|reels|tv|stories)\// },
  { site: 'TikTok', hosts: ['tiktok.com'], paths: /\/video\/|^\/t\/|^\/@[^/]+\/video/ },
  { site: 'X', hosts: ['x.com', 'twitter.com'], paths: /\/status\/\d+/ },
  { site: 'Vimeo', hosts: ['vimeo.com'], paths: /^\/\d+/ },
  { site: 'Dailymotion', hosts: ['dailymotion.com', 'dai.ly'], paths: /^\/(video\/|[a-z0-9]+$)/ },
  { site: 'SoundCloud', hosts: ['soundcloud.com'], paths: /^\/[^/]+\/[^/]+/ },
];

/** @returns {string|null} site name if yt-dlp should handle this link */
function mediaSiteOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|music|web)\./, '');
  for (const s of MEDIA_SITES) {
    if (s.hosts.some((h) => host === h || host.endsWith(`.${h}`)) && s.paths.test(u.pathname)) return s.site;
  }
  return null;
}

module.exports = { MEDIA_SITES, mediaSiteOf };

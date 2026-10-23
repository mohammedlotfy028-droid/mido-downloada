// Number formatting helpers (size, speed, time left).
window.Format = {
  bytes(n, t) {
    if (!n || n < 0) return '—';
    let i = 0;
    while (n >= 1024 && i < t.units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${t.units[i]}`;
  },

  speed(bps, t) {
    return bps > 0 ? `${this.bytes(bps, t)}${t.perSec}` : '—';
  },

  eta(remaining, bps, t) {
    if (!(bps > 0) || !(remaining > 0)) return '—';
    let s = Math.round(remaining / bps);
    const { time } = t;
    if (s < 60) return `${s}${time.s}`;
    const d = Math.floor(s / 86400);
    s %= 86400;
    const h = Math.floor(s / 3600);
    s %= 3600;
    const m = Math.floor(s / 60);
    s %= 60;
    if (d) return `${d}${time.d} ${h}${time.h}`;
    if (h) return `${h}${time.h} ${m}${time.m}`;
    return `${m}${time.m} ${s}${time.s}`;
  },
};

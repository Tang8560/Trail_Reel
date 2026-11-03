// Dates, times and numbers always in English, whatever the device language.
const LOCALE = 'en-US';

export const fmtKm = (m, digits = 2) => `${(m / 1000).toFixed(digits)} km`;

export const fmtMeters = (m) => `${Math.round(m).toLocaleString(LOCALE)} m`;

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const mins = Math.floor(ms / 60000); // truncate, like hiking apps do
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

export const fmtClock = (ms) =>
  new Date(ms).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });

export const fmtDate = (ms) =>
  new Date(ms).toLocaleDateString(LOCALE, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

/** "Nov 1 – 3, 2026", "Oct 30 – Nov 2, 2026" or "Dec 30, 2026 – Jan 2, 2027". */
export function fmtDateRange(a, b) {
  const A = new Date(a);
  const B = new Date(b);
  const md = (d) => d.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });
  if (A.getFullYear() !== B.getFullYear()) return `${md(A)}, ${A.getFullYear()} – ${md(B)}, ${B.getFullYear()}`;
  const end = A.getMonth() === B.getMonth() ? B.getDate() : md(B);
  return `${md(A)} – ${end}, ${B.getFullYear()}`;
}

const dayStart = (ms) => new Date(ms).setHours(0, 0, 0, 0);
/** Calendar day of `ms` counted from the day of `startMs` (1 = same day). Rounded for DST. */
export const dayNumber = (ms, startMs) => Math.round((dayStart(ms) - dayStart(startMs)) / 86400000) + 1;

export const fmtDateTime = (ms) =>
  new Date(ms).toLocaleString(LOCALE, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

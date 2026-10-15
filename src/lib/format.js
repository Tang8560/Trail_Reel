export const fmtKm = (m, digits = 2) => `${(m / 1000).toFixed(digits)} km`;

export const fmtMeters = (m) => `${Math.round(m).toLocaleString()} m`;

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const mins = Math.floor(ms / 60000); // truncate, like hiking apps do
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

export const fmtClock = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export const fmtDate = (ms) =>
  new Date(ms).toLocaleDateString([], {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

export const fmtDateTime = (ms) =>
  new Date(ms).toLocaleString([], {
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

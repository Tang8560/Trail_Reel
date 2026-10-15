import { distanceAtTime, distanceNearLocation } from './gpx';

/**
 * Decide where along the track each photo/video was taken.
 * Priority: timestamp within the GPX time range → embedded GPS → order among neighbours.
 * Returns [{ item, dist, via }] sorted along the trail.
 */
export function placeMedia(items, track, clockOffsetMin = 0) {
  const offset = clockOffsetMin * 60000;
  const rows = items
    .map((item) => ({ item, t: item.time != null ? item.time + offset : null, dist: null, via: 'order' }))
    .sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity) || a.item.name.localeCompare(b.item.name));

  if (!track) return rows.map((r) => ({ ...r, dist: null, via: 'time' }));

  for (const r of rows) {
    if (track.hasTime && r.t != null) {
      const d = distanceAtTime(track, r.t);
      if (d != null) {
        r.dist = d;
        r.via = 'time';
        continue;
      }
    }
    if (r.item.lat != null) {
      const d = distanceNearLocation(track, r.item.lat, r.item.lon);
      if (d != null) {
        r.dist = d;
        r.via = 'gps';
      }
    }
  }

  if (rows.every((r) => r.dist == null)) {
    // Nothing matched: spread evenly along the trail in time order.
    rows.forEach((r, i) => (r.dist = (track.totalDist * (i + 1)) / (rows.length + 1)));
  } else {
    // Unmatched items follow the previous matched item in time order.
    let last = 0;
    for (const r of rows) {
      if (r.dist == null) r.dist = last;
      else last = r.dist;
    }
  }

  return rows.map((r, i) => ({ ...r, order: i })).sort((a, b) => a.dist - b.dist || a.order - b.order);
}

const MAP_LIKE = new Set(['intro', 'route', 'outro']);

export function buildSegments(placed, track, s) {
  const segs = [{ type: 'intro', duration: 4 }];
  let cur = 0;
  const addRoute = (to) => {
    if (!track) return;
    const delta = to - cur;
    if (delta > track.totalDist * 0.003) {
      segs.push({
        type: 'route',
        from: cur,
        to,
        duration: Math.max(1, (s.routeSeconds * delta) / track.totalDist),
      });
    }
    cur = Math.max(cur, to);
  };

  for (const p of placed) {
    if (p.dist != null) addRoute(p.dist);
    const it = p.item;
    if (it.kind === 'video') {
      const start = Math.max(0, Math.min(s.clipStart, it.duration - 1));
      segs.push({
        type: 'video',
        item: it,
        dist: track ? cur : null,
        time: p.t,
        start,
        duration: Math.max(0.5, Math.min(it.duration - start, s.maxClip)),
      });
    } else {
      segs.push({ type: 'photo', item: it, dist: track ? cur : null, time: p.t, duration: s.photoSeconds });
    }
  }
  if (track) addRoute(track.totalDist);
  segs.push({ type: 'outro', duration: 5 });

  // Dip to black between segments, except when the map simply continues.
  segs.forEach((seg, i) => {
    const prev = segs[i - 1];
    const next = segs[i + 1];
    const mapLike = (x) => x && track && MAP_LIKE.has(x.type);
    seg.fadeIn = !(mapLike(seg) && mapLike(prev));
    seg.fadeOut = !(mapLike(seg) && mapLike(next));
  });
  return segs;
}

export const totalDuration = (segs) => segs.reduce((s, x) => s + x.duration, 0);

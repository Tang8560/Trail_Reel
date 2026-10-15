const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;

export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function childText(el, tag) {
  const c = el.getElementsByTagName(tag)[0];
  return c ? c.textContent.trim() : null;
}

// Phone GPS wanders a few metres even when standing still (and many apps keep logging
// overnight at camp). Only movement of at least this much from the last counted position
// is counted as distance; this is what keeps a 38 km hike from reading 50 km.
const MIN_STEP_M = 10;
const SMOOTH_WINDOW_M = 50; // elevation moving-average window along the (filtered) trail...
const SMOOTH_MIN_POINTS = 5; // ...widened for sparse tracks so it always averages enough samples
const GAIN_THRESHOLD_M = 3; // reversals smaller than this are treated as noise

/**
 * Cumulative distance per point, per segment, ignoring GPS jitter (see MIN_STEP_M).
 * Points where the counted position moved are flagged `anchor`. Gaps between segments
 * (recording paused) add no distance.
 */
function measureDistance(segments) {
  let dist = 0;
  for (const seg of segments) {
    let anchor = seg[0];
    for (const p of seg) {
      const step = haversine(anchor, p);
      p.anchor = p === seg[0] || step >= MIN_STEP_M;
      if (p.anchor && p !== seg[0]) {
        dist += step;
        anchor = p;
      }
      p.dist = dist;
    }
  }
  return dist;
}

/** Distance-based moving average of elevation (robust to uneven point spacing). */
function smoothElevation(points, windowM) {
  const half = windowM / 2;
  const out = new Array(points.length);
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const d = points[i].dist;
    while (hi < points.length && points[hi].dist <= d + half) sum += points[hi++].ele;
    while (points[lo].dist < d - half) sum -= points[lo++].ele;
    out[i] = sum / (hi - lo);
  }
  return out;
}

/**
 * Total elevation gain/loss. Uses only positions where the hiker actually moved (anchors),
 * smooths elevation along the trail, then counts climbs with peak/valley hysteresis: every
 * new high while climbing counts, and the direction only flips after retreating
 * GAIN_THRESHOLD_M from the last extreme. Sets p.gain (cumulative) on every point.
 */
export function computeElevationGain(points) {
  const anchors = points.filter((p) => p.anchor !== false);
  const spacing = anchors[anchors.length - 1].dist / Math.max(1, anchors.length - 1);
  const ele = smoothElevation(anchors, Math.max(SMOOTH_WINDOW_M, spacing * SMOOTH_MIN_POINTS));
  let gain = 0;
  let loss = 0;
  let dir = 0; // 1 climbing, -1 descending, 0 not yet known
  let ext = ele[0]; // highest point of the current climb / lowest of the current descent
  for (let i = 0; i < anchors.length; i++) {
    const e = ele[i];
    if (dir === 1) {
      if (e > ext) {
        gain += e - ext;
        ext = e;
      } else if (ext - e >= GAIN_THRESHOLD_M) {
        loss += ext - e;
        dir = -1;
        ext = e;
      }
    } else if (dir === -1) {
      if (e < ext) {
        loss += ext - e;
        ext = e;
      } else if (e - ext >= GAIN_THRESHOLD_M) {
        gain += e - ext;
        dir = 1;
        ext = e;
      }
    } else if (e - ext >= GAIN_THRESHOLD_M) {
      gain += e - ext;
      dir = 1;
      ext = e;
    } else if (ext - e >= GAIN_THRESHOLD_M) {
      loss += ext - e;
      dir = -1;
      ext = e;
    }
    anchors[i].gain = gain;
  }
  // Non-anchor points carry the gain of the last anchor before them.
  let last = 0;
  for (const p of points) {
    if (p.anchor === false) p.gain = last;
    else last = p.gain;
  }
  return { gain, loss };
}

function readPoint(n) {
  const lat = parseFloat(n.getAttribute('lat'));
  const lon = parseFloat(n.getAttribute('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const eleText = childText(n, 'ele');
  const timeText = childText(n, 'time');
  const time = timeText ? Date.parse(timeText) : NaN;
  return {
    lat,
    lon,
    ele: eleText != null ? parseFloat(eleText) : NaN,
    time: Number.isFinite(time) ? time : null,
  };
}

/** Parse GPX text into a track with cumulative distance / elevation gain per point. */
export function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Could not parse GPX file');

  // Keep track segments separate: a new <trkseg> means recording was paused.
  let groups = Array.from(doc.getElementsByTagName('trkseg')).map((s) => Array.from(s.getElementsByTagName('trkpt')));
  if (!groups.some((g) => g.length)) groups = [Array.from(doc.getElementsByTagName('rtept'))];
  const segments = groups.map((g) => g.map(readPoint).filter(Boolean)).filter((g) => g.length);
  const points = segments.flat();
  if (points.length < 2) throw new Error('GPX file has no track points');

  const trk = doc.getElementsByTagName('trk')[0];
  const metadata = doc.getElementsByTagName('metadata')[0];
  const name = (trk && childText(trk, 'name')) || (metadata && childText(metadata, 'name')) || '';

  const dist = measureDistance(segments);

  // Fill missing elevations with the last known value.
  const hasEle = points.some((p) => Number.isFinite(p.ele));
  if (hasEle) {
    let last = points.find((p) => Number.isFinite(p.ele)).ele;
    for (const p of points) {
      if (Number.isFinite(p.ele)) last = p.ele;
      else p.ele = last;
    }
  } else {
    points.forEach((p) => (p.ele = 0));
  }

  const { gain, loss } = computeElevationGain(points);
  let minEle = Infinity;
  let maxEle = -Infinity;
  for (const p of points) {
    minEle = Math.min(minEle, p.ele);
    maxEle = Math.max(maxEle, p.ele);
  }

  const timed = points.filter((p) => p.time != null);
  const hasTime = timed.length >= points.length * 0.5;
  if (hasTime) timed.sort((a, b) => a.time - b.time);

  // Recorded time: sum of segment durations, so pauses between segments don't count.
  const duration = hasTime
    ? segments.reduce((total, seg) => {
        const t = seg.filter((p) => p.time != null).map((p) => p.time);
        return t.length > 1 ? total + Math.max(...t) - Math.min(...t) : total;
      }, 0)
    : null;

  const bounds = points.reduce(
    (b, p) => ({
      minLat: Math.min(b.minLat, p.lat),
      maxLat: Math.max(b.maxLat, p.lat),
      minLon: Math.min(b.minLon, p.lon),
      maxLon: Math.max(b.maxLon, p.lon),
    }),
    { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 }
  );

  return {
    name,
    points,
    segmentCount: segments.length,
    timed: hasTime ? timed : [],
    totalDist: dist,
    gain,
    loss,
    minEle,
    maxEle,
    hasEle,
    hasTime,
    duration,
    startTime: hasTime ? timed[0].time : null,
    endTime: hasTime ? timed[timed.length - 1].time : null,
    bounds,
  };
}

/** Interpolated point at a distance (meters) along the track. */
export function pointAtDistance(points, d) {
  const n = points.length;
  if (d <= 0) return { ...points[0], idx: 0 };
  if (d >= points[n - 1].dist) return { ...points[n - 1], idx: n - 1 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (points[m].dist <= d) lo = m;
    else hi = m;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.dist - a.dist;
  const f = span > 0 ? (d - a.dist) / span : 0;
  const lerp = (x, y) => x + (y - x) * f;
  return {
    lat: lerp(a.lat, b.lat),
    lon: lerp(a.lon, b.lon),
    ele: lerp(a.ele, b.ele),
    gain: lerp(a.gain, b.gain),
    time: a.time != null && b.time != null ? lerp(a.time, b.time) : a.time,
    dist: d,
    idx: lo,
  };
}

/** Distance along the track at a timestamp (ms), or null if out of range. */
export function distanceAtTime(track, t, slackMs = 30 * 60 * 1000) {
  const pts = track.timed;
  if (!pts.length) return null;
  if (t < pts[0].time - slackMs || t > pts[pts.length - 1].time + slackMs) return null;
  if (t <= pts[0].time) return pts[0].dist;
  if (t >= pts[pts.length - 1].time) return pts[pts.length - 1].dist;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (pts[m].time <= t) lo = m;
    else hi = m;
  }
  const a = pts[lo];
  const b = pts[hi];
  const f = b.time > a.time ? (t - a.time) / (b.time - a.time) : 0;
  return a.dist + (b.dist - a.dist) * f;
}

/** Distance of the nearest track point to a location, or null if farther than maxMeters. */
export function distanceNearLocation(track, lat, lon, maxMeters = 750) {
  let best = null;
  let bestD = Infinity;
  for (const p of track.points) {
    const d = haversine(p, { lat, lon });
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best && bestD <= maxMeters ? best.dist : null;
}

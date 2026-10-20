import { pointAtDistance } from './gpx';
import { fmtClock, fmtDate, fmtDuration, fmtKm, fmtMeters } from './format';
import { getPhotoBitmap, releasePhotoBitmap, seekVideo, waitForData } from './media';

const FONT = '"Segoe UI", "Helvetica Neue", system-ui, -apple-system, sans-serif';
const FADE = 0.45;
const font = (weight, px) => `${weight} ${Math.round(px)}px ${FONT}`;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitFont(ctx, text, weight, px, maxW) {
  ctx.font = font(weight, px);
  const w = ctx.measureText(text).width;
  if (w > maxW) ctx.font = font(weight, (px * maxW) / w);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

// Pin sprites carry their drop shadow baked in: canvas shadowBlur is very slow per frame.
const PIN = 128;
const PIN_PAD = 24;

function makePin(thumbCanvas, accent) {
  const size = PIN;
  const c = makeCanvas(size + PIN_PAD * 2, size + PIN_PAD * 2);
  const ctx = c.getContext('2d');
  ctx.translate(PIN_PAD, PIN_PAD);
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 21;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(thumbCanvas, 8, 8, size - 16, size - 16);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.stroke();
  return c;
}

/**
 * Drop screen points closer than `tol` px to the last kept one. GPX tracks often have tens of
 * thousands of points, far more than the pixels they cover. `map[i]` is the kept index for
 * original point i, so `pointAtDistance().idx` still works.
 */
function simplifyPath(raw, tol) {
  const pts = [raw[0]];
  const map = new Int32Array(raw.length);
  let [lx, ly] = raw[0];
  for (let i = 1; i < raw.length; i++) {
    const [x, y] = raw[i];
    if (i === raw.length - 1 || (x - lx) ** 2 + (y - ly) ** 2 >= tol * tol) {
      pts.push(raw[i]);
      lx = x;
      ly = y;
    }
    map[i] = pts.length - 1;
  }
  return { pts, map };
}

export function createScene({ W, H, track, basemap, placed, settings, title, subtitle, stats }) {
  const u = Math.min(W, H) / 1080;
  const scene = {
    W,
    H,
    u,
    track,
    basemap,
    settings,
    title,
    subtitle,
    stats,
    accent: settings.accent,
    segCache: new WeakMap(),
  };
  const blur = document.createElement('canvas');
  blur.width = Math.max(16, Math.round(W / 24));
  blur.height = Math.max(16, Math.round(H / 24));
  scene.blur = blur;

  if (track && basemap) {
    const raw = track.points.map((p) => basemap.toScreen(p.lat, p.lon));
    const { pts, map } = simplifyPath(raw, 0.75);
    scene.pts = pts;
    scene.ptIdx = map;
    scene.routeBox = scene.pts.reduce(
      (b, [px, py]) => ({
        minX: Math.min(b.minX, px),
        maxX: Math.max(b.maxX, px),
        minY: Math.min(b.minY, py),
        maxY: Math.max(b.maxY, py),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    );
    scene.pins = placed.map((p) => {
      const pt = pointAtDistance(track.points, p.dist);
      const [x, y] = basemap.toScreen(pt.lat, pt.lon);
      return { x, y, dist: p.dist, img: makePin(p.item.thumbCanvas, settings.accent) };
    });
    // Elevation profile, sampled evenly along distance.
    const N = 300;
    scene.profile = Array.from({ length: N + 1 }, (_, i) =>
      pointAtDistance(track.points, (track.totalDist * i) / N).ele
    );
    buildStaticLayers(scene);
  }
  return scene;
}

/** Pre-render everything that doesn't change between frames, once per scene. */
function buildStaticLayers(scene) {
  const { W, H, u, track } = scene;

  // Basemap + vignette + full route outline.
  scene.mapLayer = makeCanvas(W, H);
  const m = scene.mapLayer.getContext('2d');
  drawMapBase(m, scene);
  strokeOutline(m, scene, 1);

  // Title bar.
  scene.titleLayer = makeCanvas(W, 200 * u);
  drawTitleBarStatic(scene.titleLayer.getContext('2d'), scene);

  // Bottom HUD band + elevation profile (base and accent-filled copy).
  const hud = hudGeometry(scene);
  scene.hud = hud;
  scene.hudLayer = makeCanvas(W, hud.band);
  const h = scene.hudLayer.getContext('2d');
  h.translate(0, -(H - hud.band));
  const g = h.createLinearGradient(0, H - hud.band, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0.8)');
  h.fillStyle = g;
  h.fillRect(0, H - hud.band, W, hud.band);
  if (track.hasEle) {
    profileShape(h, scene, hud.pad, hud.py, hud.pw, hud.ph);
    h.fillStyle = 'rgba(255,255,255,0.28)';
    h.fill();
    h.strokeStyle = 'rgba(255,255,255,0.85)';
    h.lineWidth = 2 * u;
    h.stroke();
    scene.profileFill = makeCanvas(hud.pw, hud.ph + 8);
    const p = scene.profileFill.getContext('2d');
    profileShape(p, scene, 0, 4, hud.pw, hud.ph);
    p.fillStyle = hexAlpha(scene.accent, 0.75);
    p.fill();
  }

  // Inset map frame (shadow, map crop and route outline); the traveled part is drawn live.
  const ins = insetGeometry(scene);
  scene.inset = ins;
  scene.insetLayer = makeCanvas(ins.w + ins.pad * 2, ins.h + ins.pad * 2);
  const c = scene.insetLayer.getContext('2d');
  c.translate(ins.pad - ins.x, ins.pad - ins.y);
  c.shadowColor = 'rgba(0,0,0,0.5)';
  c.shadowBlur = 24 * u;
  roundRect(c, ins.x, ins.y, ins.w, ins.h, 18 * u);
  c.fillStyle = '#000';
  c.fill();
  c.shadowBlur = 0;
  c.clip();
  c.translate(ins.x - ins.sx * ins.s, ins.y - ins.sy * ins.s);
  c.scale(ins.s, ins.s);
  c.drawImage(scene.basemap.canvas, 0, 0);
  strokeOutline(c, scene, ins.k);
}

/* ───────────────────────── map layers ───────────────────────── */

function drawMapBase(ctx, scene) {
  const { W, H, basemap } = scene;
  ctx.drawImage(basemap.canvas, 0, 0);
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (basemap.attribution) {
    ctx.font = font(400, 15 * scene.u);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillText(basemap.attribution, W - 12 * scene.u, H - 8 * scene.u);
    ctx.textAlign = 'left';
  }
}

function tracePath(ctx, pts, endIdx, end) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i <= endIdx; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  if (end) ctx.lineTo(end[0], end[1]);
}

/** The whole route as a white line with a dark edge. Static, so it lives in cached layers. */
function strokeOutline(ctx, scene, k) {
  const { pts, u } = scene;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  tracePath(ctx, pts, pts.length - 1);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 13 * u * k;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 7 * u * k;
  ctx.stroke();
  ctx.restore();
}

/**
 * Traveled portion + start/finish dots + photo pins + position marker, drawn over a layer
 * that already has the route outline. k scales line widths.
 */
function drawRouteLayer(ctx, scene, dist, now, { k = 1, pins = true, marker = true, routeAlpha = 1 } = {}) {
  const { pts, track, basemap, u, accent } = scene;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha *= routeAlpha;

  const pos = pointAtDistance(track.points, dist);
  const end = basemap.toScreen(pos.lat, pos.lon);
  if (dist > 0) {
    tracePath(ctx, pts, scene.ptIdx[pos.idx], end);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 9 * u * k;
    ctx.stroke();
  }

  // Start / finish dots
  const dot = (p, color) => {
    ctx.beginPath();
    ctx.arc(p[0], p[1], 9 * u * k, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 3.5 * u * k;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  };
  dot(pts[pts.length - 1], '#e5484d');
  dot(pts[0], '#30a46c');

  if (pins && scene.pins) {
    const pop = track.totalDist * 0.012;
    for (const pin of scene.pins) {
      if (pin.dist > dist) continue;
      const s = pins === 'all' ? 1 : easeOut(clamp((dist - pin.dist) / pop));
      if (s <= 0) continue;
      const r = 30 * u * k * s;
      const cy = pin.y - r - 10 * u * k * s;
      ctx.beginPath();
      ctx.moveTo(pin.x, pin.y);
      ctx.lineTo(pin.x - 9 * u * k * s, cy + r * 0.7);
      ctx.lineTo(pin.x + 9 * u * k * s, cy + r * 0.7);
      ctx.closePath();
      ctx.fillStyle = '#fff';
      ctx.fill();
      const R = (r * pin.img.width) / PIN;
      ctx.drawImage(pin.img, pin.x - R, cy - R, R * 2, R * 2);
    }
  }

  if (marker) {
    const pulse = (now % 1.4) / 1.4;
    ctx.beginPath();
    ctx.arc(end[0], end[1], (12 + 26 * pulse) * u * k, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(accent, 0.45 * (1 - pulse));
    ctx.fill();
    ctx.beginPath();
    ctx.arc(end[0], end[1], 12 * u * k, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.lineWidth = 4.5 * u * k;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }
  ctx.restore();
  return pos;
}

function hexAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/* ───────────────────────── HUD ───────────────────────── */

function drawTitleBar(ctx, scene, alpha = 1) {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(scene.titleLayer, 0, 0);
  ctx.restore();
}

function drawTitleBarStatic(ctx, scene) {
  const { W, u } = scene;
  ctx.save();
  const g = ctx.createLinearGradient(0, 0, 0, 200 * u);
  g.addColorStop(0, 'rgba(0,0,0,0.6)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, 200 * u);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 8 * u;
  fitFont(ctx, scene.title, 700, 48 * u, W * 0.6);
  ctx.fillText(scene.title, 48 * u, 82 * u);
  if (scene.subtitle) {
    ctx.font = font(400, 26 * u);
    ctx.globalAlpha = 0.85;
    ctx.fillText(scene.subtitle, 48 * u, 122 * u);
  }
  ctx.restore();
}

const profileY = (scene, y, h, e) => {
  const { track } = scene;
  const range = Math.max(1, track.maxEle - track.minEle);
  return y + h - ((e - track.minEle) / range) * h * 0.92;
};

function profileShape(ctx, scene, x, y, w, h) {
  const { profile } = scene;
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  profile.forEach((e, i) => ctx.lineTo(x + (w * i) / (profile.length - 1), profileY(scene, y, h, e)));
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

/** Live part of the profile; the base shape is in scene.hudLayer. */
function drawProfile(ctx, scene, dist, x, y, w, h) {
  const { track } = scene;
  const fw = w * clamp(dist / track.totalDist);
  const cx = x + fw;
  if (fw >= 0.5) {
    const fill = scene.profileFill;
    ctx.drawImage(fill, 0, 0, fw, fill.height, x, y - 4, fw, fill.height);
  }
  const py = (e) => profileY(scene, y, h, e);
  const ce = pointAtDistance(track.points, dist).ele;
  ctx.beginPath();
  ctx.moveTo(cx, y + h);
  ctx.lineTo(cx, py(ce));
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5 * scene.u;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, py(ce), 7 * scene.u, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
}

function statLine(scene, pos) {
  const { track } = scene;
  const parts = [fmtKm(pos.dist)];
  if (track.hasEle) parts.push(`+${fmtMeters(pos.gain)}`, `Alt ${fmtMeters(pos.ele)}`);
  if (pos.time != null) parts.push(fmtClock(pos.time));
  return parts;
}

function hudGeometry(scene) {
  const { W, H, u, track } = scene;
  const pad = 48 * u;
  const ph = track.hasEle ? 90 * u : 0;
  return { band: 300 * u, pad, ph, pw: W - pad * 2, py: H - pad - ph };
}

function drawBottomHud(ctx, scene, dist, alpha = 1) {
  const { H, u, track } = scene;
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  const { band, pad, ph, pw, py } = scene.hud;
  ctx.drawImage(scene.hudLayer, 0, H - band);
  if (track.hasEle) drawProfile(ctx, scene, dist, pad, py, pw, ph);

  const pos = pointAtDistance(track.points, dist);
  ctx.font = font(600, 32 * u);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 6 * u;
  let x = pad;
  for (const part of statLine(scene, pos)) {
    ctx.fillText(part, x, py - 22 * u);
    x += ctx.measureText(part).width + 36 * u;
  }
  ctx.restore();
}

/* ───────────────────────── segments ───────────────────────── */

function drawPlainBackground(ctx, scene) {
  const { W, H, accent } = scene;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0f1f1a');
  g.addColorStop(1, '#16251f');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const r = ctx.createRadialGradient(W * 0.75, H * 0.2, 0, W * 0.75, H * 0.2, Math.max(W, H) * 0.7);
  r.addColorStop(0, hexAlpha(accent, 0.35));
  r.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = r;
  ctx.fillRect(0, 0, W, H);
}

function drawCenteredTitle(ctx, scene, a, slide) {
  const { W, H, u } = scene;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 18 * u;
  const y = H * 0.42 + slide * 40 * u;
  fitFont(ctx, scene.title, 800, 96 * u, W * 0.86);
  ctx.fillText(scene.title, W / 2, y);
  if (scene.subtitle) {
    ctx.font = font(400, 34 * u);
    ctx.globalAlpha = a * 0.9;
    ctx.fillText(scene.subtitle, W / 2, y + 78 * u);
  }
  ctx.restore();
}

function drawChips(ctx, scene, items, y, a) {
  const { W, u, accent } = scene;
  if (!items.length) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = font(600, 30 * u);
  const padX = 26 * u;
  const h = 64 * u;
  const gap = 18 * u;
  const widths = items.map((s) => ctx.measureText(s).width + padX * 2);
  const total = widths.reduce((s, w) => s + w, 0) + gap * (items.length - 1);
  const scale = Math.min(1, (W * 0.92) / total);
  ctx.translate(W / 2, y);
  ctx.scale(scale, scale);
  let x = -total / 2;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  items.forEach((s, i) => {
    roundRect(ctx, x, -h / 2, widths[i], h, h / 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    ctx.lineWidth = 2 * u;
    ctx.strokeStyle = hexAlpha(accent, 0.9);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(s, x + widths[i] / 2, 2 * u);
    x += widths[i] + gap;
  });
  ctx.restore();
}

function drawIntro(ctx, scene, seg, t, now) {
  const { W, H } = scene;
  const out = clamp((seg.duration - t) / 0.7);
  if (scene.track) {
    const routeAlpha = clamp(t / 1.2);
    if (routeAlpha < 1) drawMapBase(ctx, scene);
    // mapLayer = map + outline, so blending it in fades in just the outline.
    ctx.save();
    ctx.globalAlpha = routeAlpha;
    ctx.drawImage(scene.mapLayer, 0, 0);
    ctx.restore();
    drawRouteLayer(ctx, scene, 0, now, { pins: false, marker: t > 1, routeAlpha });
    ctx.fillStyle = `rgba(0,0,0,${0.4 * out})`;
    ctx.fillRect(0, 0, W, H);
    // As the intro ends, the persistent HUD fades in so the route segment continues seamlessly.
    drawTitleBar(ctx, scene, 1 - out);
    drawBottomHud(ctx, scene, 0, 1 - out);
  } else {
    drawPlainBackground(ctx, scene);
  }
  const a = easeOut(clamp((t - 0.3) / 0.8)) * out;
  drawCenteredTitle(ctx, scene, a, 1 - a);
  drawChips(ctx, scene, scene.stats.chips, H * 0.62, a);
}

function drawRouteSegment(ctx, scene, seg, t, now) {
  const dist = seg.from + (seg.to - seg.from) * easeInOut(clamp(t / seg.duration));
  ctx.drawImage(scene.mapLayer, 0, 0);
  drawRouteLayer(ctx, scene, dist, now);
  drawTitleBar(ctx, scene);
  drawBottomHud(ctx, scene, dist);
}

function drawOutro(ctx, scene, seg, t, now) {
  const { W, H, u, accent } = scene;
  const a = easeOut(clamp(t / 1));
  if (scene.track) {
    ctx.drawImage(scene.mapLayer, 0, 0);
    drawRouteLayer(ctx, scene, scene.track.totalDist, now, { pins: 'all', marker: false });
    drawTitleBar(ctx, scene, 1 - a);
    drawBottomHud(ctx, scene, scene.track.totalDist, 1 - a);
  } else {
    drawPlainBackground(ctx, scene);
  }
  ctx.fillStyle = `rgba(8,14,12,${0.72 * a})`;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  fitFont(ctx, scene.title, 800, 64 * u, W * 0.86);
  ctx.fillText(scene.title, W / 2, H * 0.3);

  const tiles = scene.stats.tiles;
  const cols = W > H ? Math.min(4, tiles.length) : 2;

  const tw = Math.min(360 * u, (W * 0.9) / cols - 20 * u);
  const th = 170 * u;
  const gap = 24 * u;
  const gridW = cols * tw + (cols - 1) * gap;
  const top = H * 0.42;
  tiles.forEach((tile, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = W / 2 - gridW / 2 + c * (tw + gap);
    const y = top + r * (th + gap) + (1 - easeOut(clamp((t - 0.2 - i * 0.12) / 0.6))) * 30 * u;
    roundRect(ctx, x, y, tw, th, 22 * u);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.fillRect(x + 28 * u, y + 30 * u, 44 * u, 5 * u);
    ctx.fillStyle = '#fff';
    fitFont(ctx, tile.value, 800, 52 * u, tw - 40 * u);
    ctx.fillText(tile.value, x + tw / 2, y + th * 0.52);
    ctx.font = font(500, 24 * u);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(tile.label.toUpperCase(), x + tw / 2, y + th * 0.82);
  });
  ctx.restore();
}

function insetGeometry(scene) {
  const { W, H, u, routeBox: rb } = scene;
  // Fixed 4:3 box in any output format, showing the basemap cropped around the route.
  const w = Math.min(W, H) * (W > H ? 0.4 : 0.42);
  const h = w * 0.75;
  const x = W - w - 36 * u;
  const y = 36 * u;
  let sw = (rb.maxX - rb.minX) * 1.3;
  let sh = (rb.maxY - rb.minY) * 1.3;
  if (sw / sh > w / h) sh = (sw * h) / w;
  else sw = (sh * w) / h;
  // Keep the crop inside the rendered basemap so no empty edges show.
  const fit = Math.min(1, W / sw, H / sh);
  sw *= fit;
  sh *= fit;
  const sx = Math.min(Math.max((rb.minX + rb.maxX) / 2 - sw / 2, 0), W - sw);
  const sy = Math.min(Math.max((rb.minY + rb.maxY) / 2 - sh / 2, 0), H - sh);
  const s = w / sw;
  return { x, y, w, h, sx, sy, s, k: 0.55 / s, pad: Math.ceil(60 * u) };
}

function drawInsetMap(ctx, scene, dist, now) {
  const { u } = scene;
  const { x, y, w, h, sx, sy, s, k, pad } = scene.inset;
  ctx.drawImage(scene.insetLayer, x - pad, y - pad);
  ctx.save();
  roundRect(ctx, x, y, w, h, 18 * u);
  ctx.clip();
  ctx.translate(x - sx * s, y - sy * s);
  ctx.scale(s, s);
  drawRouteLayer(ctx, scene, dist, now, { k, pins: false });
  ctx.restore();
  roundRect(ctx, x, y, w, h, 18 * u);
  ctx.lineWidth = 3 * u;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();
}

/** Draw src cover-fitted into the small canvas `into` (upscaling it later blurs it). */
function makeBlur(into, src, sw, sh) {
  const s = Math.max(into.width / sw, into.height / sh);
  into.getContext('2d').drawImage(src, (into.width - sw * s) / 2, (into.height - sh * s) / 2, sw * s, sh * s);
  return into;
}

/** A black w×h box with a soft drop shadow, rendered at quarter scale. */
function makeShadow(w, h, blurPx) {
  const q = 0.25;
  const b = blurPx * q;
  const pad = Math.ceil(b * 2.5);
  const canvas = makeCanvas(w * q + pad * 2, h * q + pad * 2);
  const c = canvas.getContext('2d');
  c.shadowColor = 'rgba(0,0,0,0.55)';
  c.shadowBlur = b;
  c.fillStyle = '#000';
  c.fillRect(pad, pad, w * q, h * q);
  return { canvas, q, pad };
}

function drawMedia(ctx, scene, seg, src, sw, sh, t, now) {
  const { W, H, u, blur, track } = scene;
  if (!sw || !sh) return;

  const isPhoto = seg.type === 'photo';
  let cache = scene.segCache.get(seg);
  if (!cache || cache.src !== src || cache.sw !== sw || cache.sh !== sh) {
    cache = { src, sw, sh };
    scene.segCache.set(seg, cache);
  }

  // Cheap blurred backdrop: downscale then upscale. A photo's never changes, so it's made once.
  let backdrop = blur;
  if (isPhoto) {
    cache.blur ||= makeBlur(makeCanvas(blur.width, blur.height), src, sw, sh);
    backdrop = cache.blur;
  } else {
    makeBlur(blur, src, sw, sh);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(backdrop, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, W, H);

  const p = clamp(t / seg.duration);
  const fill = Math.abs(Math.log(sw / sh / (W / H))) < 0.25;
  const base = fill ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const kb = isPhoto ? 1 + 0.08 * easeInOut(p) : 1;
  const dw = sw * base * kb;
  const dh = sh * base * kb;
  const dir = seg.item.id % 2 ? 1 : -1;
  const panX = fill ? dir * (dw - W) * 0.5 * (p - 0.5) : 0;
  const dx = (W - dw) / 2 + panX;
  const dy = (H - dh) / 2;
  if (!fill) {
    // Drop shadow pre-rendered at quarter size and scaled up; live shadowBlur is too slow.
    cache.shadow ||= makeShadow(sw * base, sh * base, 40 * u);
    const { canvas: sc, q, pad } = cache.shadow;
    const k = kb / q;
    ctx.drawImage(sc, dx - pad * k, dy - pad * k, sc.width * k, sc.height * k);
  }
  // Video frames change every frame, so use cheaper (but still smooth) resampling for them.
  ctx.imageSmoothingQuality = isPhoto ? 'high' : 'medium';
  ctx.drawImage(src, dx, dy, dw, dh);

  // Caption
  const lines = [];
  if (seg.time != null) lines.push(fmtClock(seg.time));
  if (track && seg.dist != null) {
    const pos = pointAtDistance(track.points, seg.dist);
    const sub = [fmtKm(seg.dist, 1)];
    if (track.hasEle) sub.push(fmtMeters(pos.ele));
    lines.push(sub.join('  ·  '));
  }
  const a = easeOut(clamp((t - 0.3) / 0.6)) * clamp((seg.duration - t) / 0.4);
  if (lines.length) {
    ctx.save();
    ctx.globalAlpha = a;
    const g = ctx.createLinearGradient(0, H - 220 * u, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = g;
    ctx.fillRect(0, H - 220 * u, W, 220 * u);
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 8 * u;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = scene.accent;
    ctx.fillRect(48 * u, H - 150 * u, 6 * u, lines.length > 1 ? 96 * u : 48 * u);
    ctx.fillStyle = '#fff';
    ctx.font = font(700, 44 * u);
    ctx.fillText(lines[0], 72 * u, H - 108 * u);
    if (lines[1]) {
      ctx.font = font(500, 30 * u);
      ctx.fillText(lines[1], 72 * u, H - 62 * u);
    }
    ctx.restore();
  }
  if (track && scene.basemap && seg.dist != null && scene.settings.insetMap) {
    ctx.save();
    ctx.globalAlpha = a;
    drawInsetMap(ctx, scene, seg.dist, now);
    ctx.restore();
  }
}

export function drawSegment(ctx, scene, seg, t, now) {
  ctx.save();
  switch (seg.type) {
    case 'intro':
      drawIntro(ctx, scene, seg, t, now);
      break;
    case 'route':
      drawRouteSegment(ctx, scene, seg, t, now);
      break;
    case 'photo': {
      const { bitmap, thumbCanvas, width, height } = seg.item;
      if (bitmap) drawMedia(ctx, scene, seg, bitmap, width, height, t, now);
      else drawMedia(ctx, scene, seg, thumbCanvas, thumbCanvas.width, thumbCanvas.height, t, now);
      break;
    }
    case 'video': {
      const v = seg.item.video;
      drawMedia(ctx, scene, seg, v, v.videoWidth, v.videoHeight, t, now);
      break;
    }
    case 'outro':
      drawOutro(ctx, scene, seg, t, now);
      break;
  }
  ctx.restore();
  let black = 0;
  if (seg.fadeIn) black = Math.max(black, 1 - clamp(t / FADE));
  if (seg.fadeOut) black = Math.max(black, 1 - clamp((seg.duration - t) / FADE));
  if (black > 0) {
    ctx.fillStyle = `rgba(0,0,0,${black})`;
    ctx.fillRect(0, 0, scene.W, scene.H);
  }
}

/* ───────────────────────── playback ───────────────────────── */

const nextFrame = () =>
  new Promise((r) => (document.hidden ? setTimeout(r, 1000 / 30) : requestAnimationFrame(() => r())));

// A clip whose time hasn't moved for this long is stalled (decoder or file read falling behind).
const STALL_MS = 150;
// Give up on a clip that makes no progress at all for this long.
const STUCK_MS = 10000;

export async function runReel(canvas, scene, segments, { signal, onProgress, music, videoAudio, onHold }) {
  const ctx = canvas.getContext('2d');
  const total = segments.reduce((s, x) => s + x.duration, 0);
  let before = 0;
  // While held, the caller pauses the recording and music, so waiting on slow media
  // (seeking or decoding a big HEVC .mov, say) never shows up as a frozen picture.
  let held = false;
  const hold = (on) => {
    if (on !== held) {
      held = on;
      onHold?.(on);
    }
  };
  await music?.start();

  const nextPhoto = (i) => segments.slice(i + 1).find((s) => s.type === 'photo');
  // Seeking a clip takes a while (often hundreds of ms on phones). Do it ahead of time, while
  // the previous segment is still on screen, so the cut to the clip doesn't freeze the frame.
  const seeks = new Map();
  const preseek = (s) => {
    if (s?.type === 'video' && !seeks.has(s)) seeks.set(s, seekVideo(s.item.video, s.start).catch(() => {}));
  };
  preseek(segments[0]);
  for (const [i, seg] of segments.entries()) {
    if (signal?.aborted) break;
    if (seg.type === 'photo' && !seg.item.bitmap) {
      hold(true);
      await getPhotoBitmap(seg.item).catch(() => {});
    }
    // Decode the upcoming photo in the background so the cut is seamless.
    const upcoming = nextPhoto(i);
    if (upcoming) getPhotoBitmap(upcoming.item).catch(() => {});
    let video = null;
    let playing = false;
    if (seg.type === 'video') {
      video = seg.item.video;
      video.pause();
      video.muted = false;
      hold(true); // released once the clip's frames are actually moving
      preseek(seg);
      await seeks.get(seg);
      seeks.delete(seg);
      await seekVideo(video, seg.start); // no-op when the pre-seek landed
      await waitForData(video);
    }
    const after = segments[i + 1];
    if (after?.type === 'video' && after.item !== seg.item) preseek(after);
    let lastCT = -1;
    let lastMove = -Infinity;
    const onWaiting = () => (lastMove = -Infinity);
    // A newly presented frame also counts as progress (more precise than currentTime alone).
    let frameCb = 0;
    const watchFrames = () => {
      frameCb = video.requestVideoFrameCallback?.(() => {
        lastMove = performance.now();
        watchFrames();
      });
    };
    if (video) {
      if (videoAudio) music?.duck(true);
      video.addEventListener('waiting', onWaiting);
      watchFrames();
      playing = await video.play().then(
        () => true,
        () => false
      );
      lastCT = video.currentTime;
    }
    if (seg.type === 'outro') music?.fadeOut(seg.duration);

    const t0 = performance.now();
    const holdStart = performance.now();
    for (;;) {
      if (signal?.aborted) break;
      const nowMs = performance.now();
      let t = (nowMs - t0) / 1000;
      let stalled = false;
      if (video && playing) {
        if (video.currentTime !== lastCT) {
          lastCT = video.currentTime;
          lastMove = nowMs;
        }
        stalled = nowMs - lastMove > STALL_MS;
        t = video.currentTime - seg.start;
        if (video.ended || t >= seg.duration) break;
        if (stalled && nowMs - Math.max(lastMove, holdStart) > STUCK_MS) break;
      } else if (t >= seg.duration) break;
      const tc = clamp(t, 0, seg.duration);
      drawSegment(ctx, scene, seg, tc, nowMs / 1000);
      onProgress?.((before + tc) / total);
      // Hold the recording during a stall; resume only after a fresh frame is on the canvas.
      hold(stalled);
      await nextFrame();
    }
    if (video) {
      video.removeEventListener('waiting', onWaiting);
      if (frameCb) video.cancelVideoFrameCallback?.(frameCb);
      video.pause();
      if (videoAudio) music?.duck(false);
    }
    hold(false);
    // Free decoded photos right away (iOS kills tabs that hold too much image memory).
    if (seg.type === 'photo' && upcoming?.item !== seg.item) releasePhotoBitmap(seg.item);
    before += seg.duration;
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, scene.W, scene.H);
  segments.forEach((s) => s.type === 'photo' && releasePhotoBitmap(s.item));
  music?.stop();
  onProgress?.(1);
}

export function buildStats(track, items) {
  const photos = items.filter((i) => i.kind === 'photo').length;
  const videos = items.length - photos;
  const mediaLine = [photos && `${photos} photo${photos > 1 ? 's' : ''}`, videos && `${videos} video${videos > 1 ? 's' : ''}`]
    .filter(Boolean)
    .join(' · ');
  if (!track) {
    return {
      chips: mediaLine ? [mediaLine] : [],
      tiles: [
        { label: 'Photos', value: String(photos) },
        { label: 'Videos', value: String(videos) },
      ],
    };
  }
  const duration = track.duration;
  const chips = [fmtKm(track.totalDist, 1)];
  if (track.hasEle) chips.push(`▲ ${fmtMeters(track.gain)}`);
  if (duration) chips.push(fmtDuration(duration));
  const tiles = [{ label: 'Distance', value: fmtKm(track.totalDist, 1) }];
  if (track.hasEle) {
    tiles.push({ label: 'Elevation gain', value: fmtMeters(track.gain) });
    tiles.push({ label: 'Highest point', value: fmtMeters(track.maxEle) });
  }
  if (duration) tiles.push({ label: 'Time', value: fmtDuration(duration) });
  return { chips, tiles };
}

export function defaultSubtitle(track, items) {
  const t = track?.startTime ?? items.map((i) => i.time).filter(Boolean).sort((a, b) => a - b)[0];
  return t ? fmtDate(t) : '';
}

import { pointAtDistance } from './gpx';
import { fmtClock, fmtDate, fmtDuration, fmtKm, fmtMeters } from './format';
import { getPhotoBitmap, releasePhotoBitmap, seekVideo } from './media';

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

function makePin(thumbCanvas, accent) {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
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

export function createScene({ W, H, track, basemap, placed, settings, title, subtitle, stats }) {
  const u = Math.min(W, H) / 1080;
  const scene = { W, H, u, track, basemap, settings, title, subtitle, stats, accent: settings.accent };
  const blur = document.createElement('canvas');
  blur.width = Math.max(16, Math.round(W / 24));
  blur.height = Math.max(16, Math.round(H / 24));
  scene.blur = blur;

  if (track && basemap) {
    scene.pts = track.points.map((p) => basemap.toScreen(p.lat, p.lon));
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
  }
  return scene;
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

/** Route line + traveled portion + photo pins + position marker. k scales line widths. */
function drawRouteLayer(ctx, scene, dist, now, { k = 1, pins = true, marker = true, routeAlpha = 1 } = {}) {
  const { pts, track, basemap, u, accent } = scene;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha *= routeAlpha;

  tracePath(ctx, pts, pts.length - 1);
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 13 * u * k;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 7 * u * k;
  ctx.stroke();

  const pos = pointAtDistance(track.points, dist);
  const end = basemap.toScreen(pos.lat, pos.lon);
  if (dist > 0) {
    tracePath(ctx, pts, pos.idx, end);
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
      ctx.shadowColor = 'rgba(0,0,0,0.4)';
      ctx.shadowBlur = 10 * u * k;
      ctx.drawImage(pin.img, pin.x - r, cy - r, r * 2, r * 2);
      ctx.shadowBlur = 0;
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
  const { W, u } = scene;
  ctx.save();
  ctx.globalAlpha = alpha;
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
    ctx.globalAlpha = alpha * 0.85;
    ctx.fillText(scene.subtitle, 48 * u, 122 * u);
  }
  ctx.restore();
}

function drawProfile(ctx, scene, dist, x, y, w, h) {
  const { profile, track, accent } = scene;
  const range = Math.max(1, track.maxEle - track.minEle);
  const px = (i) => x + (w * i) / (profile.length - 1);
  const py = (e) => y + h - ((e - track.minEle) / range) * h * 0.92;
  const shape = () => {
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    profile.forEach((e, i) => ctx.lineTo(px(i), py(e)));
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  };
  shape();
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2 * scene.u;
  ctx.stroke();
  const cx = x + w * clamp(dist / track.totalDist);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y - 4, cx - x, h + 8);
  ctx.clip();
  shape();
  ctx.fillStyle = hexAlpha(accent, 0.75);
  ctx.fill();
  ctx.restore();
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

function drawBottomHud(ctx, scene, dist, alpha = 1) {
  const { W, H, u, track } = scene;
  ctx.save();
  ctx.globalAlpha = alpha;
  const band = 300 * u;
  const g = ctx.createLinearGradient(0, H - band, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0.8)');
  ctx.fillStyle = g;
  ctx.fillRect(0, H - band, W, band);

  const pad = 48 * u;
  const ph = track.hasEle ? 90 * u : 0;
  const py = H - pad - ph;
  if (track.hasEle) drawProfile(ctx, scene, dist, pad, py, W - pad * 2, ph);

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
    drawMapBase(ctx, scene);
    drawRouteLayer(ctx, scene, 0, now, { pins: false, marker: t > 1, routeAlpha: clamp(t / 1.2) });
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
  drawMapBase(ctx, scene);
  drawRouteLayer(ctx, scene, dist, now);
  drawTitleBar(ctx, scene);
  drawBottomHud(ctx, scene, dist);
}

function drawOutro(ctx, scene, seg, t, now) {
  const { W, H, u, accent } = scene;
  const a = easeOut(clamp(t / 1));
  if (scene.track) {
    drawMapBase(ctx, scene);
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

function drawInsetMap(ctx, scene, dist, now) {
  const { W, H, u, basemap, routeBox: rb } = scene;
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
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 24 * u;
  roundRect(ctx, x, y, w, h, 18 * u);
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.clip();
  ctx.translate(x - sx * s, y - sy * s);
  ctx.scale(s, s);
  ctx.drawImage(basemap.canvas, 0, 0);
  drawRouteLayer(ctx, scene, dist, now, { k: 0.55 / s, pins: false });
  ctx.restore();
  roundRect(ctx, x, y, w, h, 18 * u);
  ctx.lineWidth = 3 * u;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke();
}

function drawMedia(ctx, scene, seg, src, sw, sh, t, now) {
  const { W, H, u, blur, track } = scene;
  if (!sw || !sh) return;

  // Cheap blurred backdrop: downscale then upscale.
  const bctx = blur.getContext('2d');
  const bs = Math.max(blur.width / sw, blur.height / sh);
  bctx.drawImage(src, (blur.width - sw * bs) / 2, (blur.height - sh * bs) / 2, sw * bs, sh * bs);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(blur, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, W, H);

  const p = clamp(t / seg.duration);
  const fill = Math.abs(Math.log(sw / sh / (W / H))) < 0.25;
  const base = fill ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const kb = seg.type === 'photo' ? 1 + 0.08 * easeInOut(p) : 1;
  const dw = sw * base * kb;
  const dh = sh * base * kb;
  const dir = seg.item.id % 2 ? 1 : -1;
  const panX = fill ? dir * (dw - W) * 0.5 * (p - 0.5) : 0;
  const dx = (W - dw) / 2 + panX;
  const dy = (H - dh) / 2;
  if (!fill) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 40 * u;
    ctx.fillStyle = '#000';
    ctx.fillRect(dx, dy, dw, dh);
    ctx.restore();
  }
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

export async function runReel(canvas, scene, segments, { signal, onProgress, music, videoAudio }) {
  const ctx = canvas.getContext('2d');
  const total = segments.reduce((s, x) => s + x.duration, 0);
  let before = 0;
  await music?.start();

  const nextPhoto = (i) => segments.slice(i + 1).find((s) => s.type === 'photo');
  for (const [i, seg] of segments.entries()) {
    if (signal?.aborted) break;
    if (seg.type === 'photo') await getPhotoBitmap(seg.item).catch(() => {});
    // Decode the upcoming photo in the background so the cut is seamless.
    const upcoming = nextPhoto(i);
    if (upcoming) getPhotoBitmap(upcoming.item).catch(() => {});
    let video = null;
    let playing = false;
    if (seg.type === 'video') {
      video = seg.item.video;
      video.pause();
      video.muted = false;
      await seekVideo(video, seg.start);
      if (videoAudio) music?.duck(true);
      playing = await video.play().then(
        () => true,
        () => false
      );
    }
    if (seg.type === 'outro') music?.fadeOut(seg.duration);

    const t0 = performance.now();
    for (;;) {
      if (signal?.aborted) break;
      const wall = (performance.now() - t0) / 1000;
      let t = wall;
      if (video && playing) {
        t = video.currentTime - seg.start;
        if (video.ended || t >= seg.duration || wall > seg.duration + 4) break;
      } else if (t >= seg.duration) break;
      const tc = clamp(t, 0, seg.duration);
      drawSegment(ctx, scene, seg, tc, performance.now() / 1000);
      onProgress?.((before + tc) / total);
      await nextFrame();
    }
    if (video) {
      video.pause();
      if (videoAudio) music?.duck(false);
    }
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

import { pointAtDistance } from './gpx';
import { fmtMeters } from './format';
import { getPhotoBitmap, releasePhotoBitmap } from './media';

const FONT = '"Segoe UI", "Helvetica Neue", system-ui, -apple-system, sans-serif';
const font = (weight, px) => `${weight} ${Math.round(px)}px ${FONT}`;

function hexAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * The cover's hero picture: the photo taken highest up the trail (usually the summit shot),
 * else the first photo, else a video's thumbnail.
 */
function pickHero(placed, track) {
  const photos = placed.filter((p) => p.item.kind === 'photo');
  if (photos.length) {
    if (!track) return photos[0].item;
    const ele = (p) => (p.dist != null ? pointAtDistance(track.points, p.dist).ele ?? -Infinity : -Infinity);
    return photos.reduce((best, p) => (ele(p) > ele(best) ? p : best)).item;
  }
  return placed[0]?.item ?? null;
}

const WORDISH = /[A-Za-z0-9'’.\-]/;

/**
 * The title as one line, or two lines of balanced width (with the current font), or null if
 * neither fits in maxW. Breaks at spaces, or between CJK characters, never inside a word or
 * just inside brackets.
 */
function splitTitle(ctx, text, maxW) {
  const width = (s) => ctx.measureText(s.trim()).width;
  if (width(text) <= maxW) return [text];
  let best = null;
  let bestW = Infinity;
  for (let i = 1; i < text.length; i++) {
    const a = text[i - 1];
    const b = text[i];
    if (WORDISH.test(a) && WORDISH.test(b)) continue;
    if (/[([{（「]/.test(a) || /[)\]}）」,.，。、]/.test(b)) continue;
    const lines = [text.slice(0, i).trim(), text.slice(i).trim()];
    if (!lines[0] || !lines[1]) continue;
    const w = Math.max(width(lines[0]), width(lines[1]));
    if (w < bestW) {
      bestW = w;
      best = lines;
    }
  }
  return best && bestW <= maxW ? best : null;
}

function drawCoverImage(ctx, img, iw, ih, W, H) {
  const s = Math.max(W / iw, H / ih);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
}

/** The route's shape, fitted into a box, as a glowing line with start and finish dots. */
function drawRouteShape(ctx, track, box, accent, u) {
  const pts = track.points;
  const step = Math.max(1, Math.floor(pts.length / 2500));
  const lat0 = ((track.bounds.minLat + track.bounds.maxLat) / 2) * (Math.PI / 180);
  const xy = [];
  for (let i = 0; i < pts.length; i += step) xy.push([pts[i].lon * Math.cos(lat0), -pts[i].lat]);
  xy.push([pts[pts.length - 1].lon * Math.cos(lat0), -pts[pts.length - 1].lat]);
  const xs = xy.map((p) => p[0]);
  const ys = xy.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(1e-9, Math.max(...xs) - minX);
  const h = Math.max(1e-9, Math.max(...ys) - minY);
  const s = Math.min(box.w / w, box.h / h);
  const ox = box.x + (box.w - w * s) / 2;
  const oy = box.y + (box.h - h * s) / 2;
  const sp = xy.map(([x, y]) => [ox + (x - minX) * s, oy + (y - minY) * s]);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  sp.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.shadowColor = hexAlpha(accent, 0.9);
  ctx.shadowBlur = 28 * u;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 12 * u;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 5 * u;
  ctx.stroke();
  const dot = ([x, y], color) => {
    ctx.beginPath();
    ctx.arc(x, y, 13 * u, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 5 * u;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  };
  dot(sp[sp.length - 1], '#e5484d');
  dot(sp[0], '#30a46c');
  ctx.restore();
}

/** Elevation silhouette across the bottom of the safe area, with the high point labelled. */
function drawProfile(ctx, track, box, accent, u) {
  const N = 240;
  const ele = Array.from({ length: N + 1 }, (_, i) => pointAtDistance(track.points, (track.totalDist * i) / N).ele);
  const lo = track.minEle;
  const range = Math.max(1, track.maxEle - lo);
  const X = (i) => box.x + (box.w * i) / N;
  const Y = (e) => box.y + box.h - ((e - lo) / range) * box.h;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(box.x, box.y + box.h);
  ele.forEach((e, i) => ctx.lineTo(X(i), Y(e)));
  ctx.lineTo(box.x + box.w, box.y + box.h);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, box.y, 0, box.y + box.h);
  g.addColorStop(0, hexAlpha(accent, 0.85));
  g.addColorStop(1, hexAlpha(accent, 0.15));
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 3 * u;
  ctx.stroke();

  const top = ele.indexOf(Math.max(...ele));
  const px = X(top);
  const py = Y(ele[top]);
  ctx.fillStyle = '#fff';
  ctx.font = font(700, 30 * u);
  ctx.textAlign = px < box.x + box.w * 0.15 ? 'left' : px > box.x + box.w * 0.85 ? 'right' : 'center';
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(0,0,0,0.7)';
  ctx.shadowBlur = 8 * u;
  ctx.fillText(`▲ ${fmtMeters(track.maxEle)}`, px, py - 14 * u);
  ctx.restore();
}

/**
 * A ready-to-post cover image (JPEG) for the reel, designed from the hike: hero photo, route
 * shape, title, dates, stats and elevation profile. Key content stays inside the middle 3:4
 * area, which Instagram's profile grid shows when it crops a reel cover.
 */
export async function renderCover({ W, H, track, placed, title, subtitle, stats, accent }) {
  const u = Math.min(W, H) / 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Background: hero photo, else a dark accent gradient.
  const hero = pickHero(placed, track);
  let drew = false;
  if (hero?.kind === 'photo') {
    const hadBitmap = !!hero.bitmap;
    try {
      const bmp = await getPhotoBitmap(hero);
      drawCoverImage(ctx, bmp, hero.width || bmp.width, hero.height || bmp.height, W, H);
      drew = true;
    } catch {
      /* fall through to the thumbnail */
    }
    if (!hadBitmap) releasePhotoBitmap(hero);
  }
  if (!drew && hero?.thumbCanvas) {
    drawCoverImage(ctx, hero.thumbCanvas, hero.thumbCanvas.width, hero.thumbCanvas.height, W, H);
    drew = true;
  }
  if (!drew) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0f1f1a');
    g.addColorStop(1, '#1d3229');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const r = ctx.createRadialGradient(W * 0.7, H * 0.25, 0, W * 0.7, H * 0.25, Math.max(W, H) * 0.8);
    r.addColorStop(0, hexAlpha(accent, 0.45));
    r.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, W, H);
  }
  // Darken top and (more) bottom so the overlays read on any photo.
  const top = ctx.createLinearGradient(0, 0, 0, H * 0.45);
  top.addColorStop(0, 'rgba(0,0,0,0.55)');
  top.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, W, H * 0.45);
  const bot = ctx.createLinearGradient(0, H * 0.4, 0, H);
  bot.addColorStop(0, 'rgba(0,0,0,0)');
  bot.addColorStop(0.45, 'rgba(0,0,0,0.6)');
  bot.addColorStop(1, 'rgba(0,0,0,0.88)');
  ctx.fillStyle = bot;
  ctx.fillRect(0, H * 0.4, W, H * 0.6);

  // The part of the frame that survives the profile-grid crop (3:4 of the width).
  const safeH = Math.min(H, (W * 4) / 3);
  const safeTop = (H - safeH) / 2;
  const sy = (f) => safeTop + safeH * f;
  const cx = W / 2;
  const maxW = W * 0.86;

  if (track) drawRouteShape(ctx, track, { x: W * 0.2, y: sy(0.05), w: W * 0.6, h: safeH * 0.34 }, accent, u);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 14 * u;

  // Dates as a small accent kicker above the title.
  let y = sy(0.47);
  if (subtitle) {
    ctx.font = font(700, 30 * u);
    ctx.fillStyle = accent;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(subtitle.toUpperCase(), cx, y);
    ctx.fillStyle = '#fff';
  }

  // Title: as big as it fits. One line while it stays large, else two balanced lines.
  ctx.font = font(800, 100 * u);
  let px = Math.min(132 * u, (100 * u * maxW) / ctx.measureText(title).width);
  let lines = [title];
  if (px < 100 * u) {
    for (px = 132 * u; ; px *= 0.94) {
      ctx.font = font(800, px);
      lines = splitTitle(ctx, title, maxW);
      if (lines) break;
      if (px <= 64 * u) {
        lines = [title]; // still too long: squeezed to fit below
        break;
      }
    }
  }
  ctx.font = font(800, px);
  ctx.textBaseline = 'top';
  y += 24 * u;
  for (const line of lines) {
    ctx.save();
    const w = ctx.measureText(line).width;
    if (w > maxW) ctx.font = font(800, (px * maxW) / w);
    ctx.fillText(line, cx, y);
    ctx.restore();
    y += px * 1.08;
  }

  // Stats: up to three big numbers with labels.
  const tiles = stats.tiles.filter((t) => t.label !== 'Highest point').slice(0, 3);
  if (tiles.length) {
    // Grouped in the middle, even on a wide (landscape) frame.
    const rowW = Math.min(maxW, 300 * u * tiles.length);
    const colW = rowW / tiles.length;
    const ty = Math.max(y + 36 * u, sy(0.7));
    tiles.forEach((t, i) => {
      const x = W / 2 - rowW / 2 + colW * (i + 0.5);
      ctx.font = font(800, 60 * u);
      const vw = ctx.measureText(t.value).width;
      if (vw > colW - 16 * u) ctx.font = font(800, (60 * u * (colW - 16 * u)) / vw);
      ctx.fillText(t.value, x, ty);
      ctx.font = font(600, 22 * u);
      ctx.globalAlpha = 0.8;
      ctx.fillText(t.label.toUpperCase(), x, ty + 72 * u);
      ctx.globalAlpha = 1;
    });
  }
  ctx.shadowBlur = 0;

  if (track?.hasEle) drawProfile(ctx, track, { x: W * 0.07, y: sy(0.86), w: W * 0.86, h: safeH * 0.1 }, accent, u);

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  return blob;
}

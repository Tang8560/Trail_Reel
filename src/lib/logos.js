// Platform marks for the watermark, drawn with canvas paths so they stay sharp at any size
// and need no image files. Each fills a size × size box at (x, y).

export const PLATFORMS = {
  instagram: { label: 'Instagram', cta: 'FOLLOW FOR MORE TRAILS' },
  youtube: { label: 'YouTube', cta: 'SUBSCRIBE FOR MORE TRAILS' },
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Instagram: the camera glyph in white on the yellow → orange → pink → purple gradient. */
function instagram(ctx, x, y, s) {
  const g = ctx.createLinearGradient(x, y + s, x + s, y);
  g.addColorStop(0, '#feda75');
  g.addColorStop(0.3, '#fa7e1e');
  g.addColorStop(0.6, '#d62976');
  g.addColorStop(0.85, '#962fbf');
  g.addColorStop(1, '#4f5bd5');
  roundRect(ctx, x, y, s, s, s * 0.27);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = s * 0.085;
  roundRect(ctx, x + s * 0.2, y + s * 0.2, s * 0.6, s * 0.6, s * 0.17);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + s / 2, y + s / 2, s * 0.14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + s * 0.665, y + s * 0.335, s * 0.045, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
}

/** YouTube: the white play triangle on a red rounded rectangle. */
function youtube(ctx, x, y, s) {
  const h = s * 0.7;
  const top = y + (s - h) / 2;
  roundRect(ctx, x, top, s, h, h * 0.28);
  ctx.fillStyle = '#ff0033';
  ctx.fill();
  ctx.save();
  ctx.shadowBlur = 0;
  const cx = x + s / 2 + s * 0.03;
  const cy = top + h / 2;
  const t = h * 0.26;
  ctx.beginPath();
  ctx.moveTo(cx - t * 0.8, cy - t);
  ctx.lineTo(cx + t, cy);
  ctx.lineTo(cx - t * 0.8, cy + t);
  ctx.closePath();
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.restore();
}

export function drawPlatformLogo(ctx, platform, x, y, size) {
  if (platform === 'youtube') youtube(ctx, x, y, size);
  else instagram(ctx, x, y, size);
}

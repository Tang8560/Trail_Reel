const TILE = 256;

export const MAP_STYLES = {
  topo: {
    label: 'Topographic',
    url: (z, x, y, i) => `https://${'abc'[i % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`,
    maxZoom: 16,
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
    bg: '#dfe6d8',
  },
  satellite: {
    label: 'Satellite',
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 17,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    bg: '#1b2416',
  },
  streets: {
    label: 'Streets (OSM)',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    maxZoom: 17,
    attribution: '© OpenStreetMap contributors',
    bg: '#f2efe9',
  },
  plain: { label: 'No tiles (offline)', url: null, maxZoom: 17, attribution: '', bg: '#20302a' },
};

/** Web-Mercator world pixel coordinates at zoom z. */
export function project(lat, lon, z) {
  const size = TILE * 2 ** z;
  const sin = Math.min(0.9999, Math.max(-0.9999, Math.sin((lat * Math.PI) / 180)));
  return [
    ((lon + 180) / 360) * size,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  ];
}

async function loadTile(url) {
  const r = await fetch(url, { mode: 'cors' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return createImageBitmap(await r.blob());
}

async function pool(jobs, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (i < jobs.length) await fn(jobs[i++]);
  });
  await Promise.all(workers);
}

/**
 * Render a static basemap sized to the output video that frames the whole track.
 * Tiles are fetched (not <img>) so a CORS failure can never taint the recording canvas.
 */
export async function buildBasemap(track, W, H, styleKey, onProgress) {
  const style = MAP_STYLES[styleKey] || MAP_STYLES.topo;
  const b = track.bounds;
  // Leave room for the title (top) and the elevation profile (bottom).
  const fitW = W * 0.78;
  const fitH = H * (W > H ? 0.56 : 0.5);
  // Fractional zoom that fits the track exactly; tiles come from the next integer zoom
  // and are drawn scaled down by `scale`, so the route fills the frame and stays crisp.
  const [a1, b1] = project(b.maxLat, b.minLon, 0);
  const [a2, b2] = project(b.minLat, b.maxLon, 0);
  const fitZoom = Math.log2(Math.min(fitW / Math.max(a2 - a1, 1e-9), fitH / Math.max(b2 - b1, 1e-9)));
  const zf = Math.min(style.maxZoom, Math.max(2, fitZoom));
  const z = Math.min(style.maxZoom, Math.ceil(zf));
  const scale = 2 ** (zf - z);
  const tile = TILE * scale;
  const [x1, y1] = project(b.maxLat, b.minLon, z);
  const [x2, y2] = project(b.minLat, b.maxLon, z);
  const ox = ((x1 + x2) / 2) * scale - W / 2;
  const oy = ((y1 + y2) / 2) * scale - H * 0.46;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = style.bg;
  ctx.fillRect(0, 0, W, H);

  let failed = 0;
  let total = 0;
  if (style.url) {
    const n = 2 ** z;
    const jobs = [];
    for (let tx = Math.floor(ox / tile); tx <= Math.floor((ox + W) / tile); tx++) {
      for (let ty = Math.floor(oy / tile); ty <= Math.floor((oy + H) / tile); ty++) {
        if (ty < 0 || ty >= n) continue;
        jobs.push({ tx, ty, wx: ((tx % n) + n) % n });
      }
    }
    total = jobs.length;
    let done = 0;
    await pool(jobs, 6, async (j) => {
      try {
        const img = await loadTile(style.url(z, j.wx, j.ty, j.tx + j.ty));
        // +0.5px overlap hides hairline seams between scaled tiles
        ctx.drawImage(img, j.tx * tile - ox, j.ty * tile - oy, tile + 0.5, tile + 0.5);
        img.close();
      } catch {
        failed++;
      }
      onProgress?.(++done / jobs.length);
    });
  }

  return {
    canvas,
    zoom: z,
    attribution: failed < total ? style.attribution : '',
    failed,
    total,
    toScreen: (lat, lon) => {
      const [x, y] = project(lat, lon, z);
      return [x * scale - ox, y * scale - oy];
    },
  };
}

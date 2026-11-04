import { loadTile, pool } from './map';

// Terrarium-encoded elevation tiles (AWS Open Data, no key, CORS enabled).
const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const DEM_TILE = 256;
const EARTH = 40075016.686;
const EXAGGERATION = 1.6;
const FOV = (40 * Math.PI) / 180;
const COLS = 200; // terrain mesh resolution across the (wide) map
// Follow camera: distance as a fraction of the overview's, and tilt above the horizon.
const CLOSE = 0.32;
const PITCH = (58 * Math.PI) / 180;
// How far ahead of the hiker the camera aims (× follow distance).
const LEAD = 0.12;
// How far (× camera distance) the aim point may slide off the hiker near the map's edge.
const MAX_SLIDE = 0.2;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Elevation for the area the basemap covers (its wide version, if any). Returns
 * heightAt(px, py) in meters, with (px, py) in basemap pixels, and how many basemap pixels
 * one meter is.
 */
export async function buildTerrain(basemap, onProgress) {
  const { z, scale, ox, oy } = basemap.world;
  const W = basemap.canvas.width;
  const H = basemap.canvas.height;
  const P = basemap.wide?.pad ?? 0;
  // One zoom below the basemap is plenty for ~30 m elevation data.
  const zt = clamp(z - 1, 1, 12);
  const f = 2 ** (zt - z) / scale; // basemap px → zoom-zt world px
  const tx0 = Math.floor(((ox - P) * f) / DEM_TILE);
  const ty0 = Math.floor(((oy - P) * f) / DEM_TILE);
  const tx1 = Math.floor(((W + P + ox) * f) / DEM_TILE);
  const ty1 = Math.floor(((H + P + oy) * f) / DEM_TILE);
  const gw = (tx1 - tx0 + 1) * DEM_TILE;
  const gh = (ty1 - ty0 + 1) * DEM_TILE;

  const canvas = document.createElement('canvas');
  canvas.width = gw;
  canvas.height = gh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const n = 2 ** zt;
  const jobs = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) if (ty >= 0 && ty < n) jobs.push({ tx, ty });
  let failed = 0;
  let done = 0;
  await pool(jobs, 6, async ({ tx, ty }) => {
    try {
      const img = await loadTile(DEM_URL(zt, ((tx % n) + n) % n, ty));
      ctx.drawImage(img, (tx - tx0) * DEM_TILE, (ty - ty0) * DEM_TILE);
      img.close();
    } catch {
      failed++;
    }
    onProgress?.(++done / jobs.length);
  });

  // Decode: meters = R·256 + G + B/256 − 32768. Missing tiles (alpha 0) count as sea level.
  const px = ctx.getImageData(0, 0, gw, gh).data;
  const dem = new Float32Array(gw * gh);
  for (let i = 0; i < dem.length; i++) {
    const j = i * 4;
    dem[i] = px[j + 3] ? px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768 : 0;
  }

  const heightAt = (x, y) => {
    const gx = clamp((x + ox) * f - tx0 * DEM_TILE, 0, gw - 1.001);
    const gy = clamp((y + oy) * f - ty0 * DEM_TILE, 0, gh - 1.001);
    const ix = gx | 0;
    const iy = gy | 0;
    const fx = gx - ix;
    const fy = gy - iy;
    const i = iy * gw + ix;
    return (dem[i] * (1 - fx) + dem[i + 1] * fx) * (1 - fy) + (dem[i + gw] * (1 - fx) + dem[i + gw + 1] * fx) * fy;
  };

  // Mercator scale at the middle of the map.
  const wy = (H / 2 + oy) / scale / (DEM_TILE * 2 ** z);
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * wy)));
  const metersPerPx = (EARTH * Math.cos(lat)) / (DEM_TILE * 2 ** z) / scale;

  return { heightAt, pxPerMeter: 1 / metersPerPx, failed, total: jobs.length };
}

/* ───────────────────────── WebGL ───────────────────────── */

const VS = `
attribute vec4 a_v; // x, y (basemap px), height (m), shade
uniform mat4 u_vp;
uniform float u_hk;
uniform vec2 u_size; // texture size in basemap px
uniform float u_pad; // how far the texture extends past the frame
varying vec2 v_uv;
varying float v_shade;
void main() {
  v_uv = (a_v.xy + u_pad) / u_size;
  v_shade = a_v.w;
  gl_Position = u_vp * vec4(a_v.x, a_v.z * u_hk, a_v.y, 1.0);
}`;

const FS = `
precision mediump float;
uniform sampler2D u_tex;
uniform float u_b;
varying vec2 v_uv;
varying float v_shade;
void main() {
  gl_FragColor = vec4(texture2D(u_tex, v_uv).rgb * mix(1.0, v_shade, u_b), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

// One WebGL context for the whole app: browsers cap how many can be alive at once.
let shared;

function initGL() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true });
  if (!gl) return null;
  try {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const loc = (name) => gl.getUniformLocation(prog, name);
    return {
      canvas,
      gl,
      prog,
      aV: gl.getAttribLocation(prog, 'a_v'),
      u: { vp: loc('u_vp'), hk: loc('u_hk'), size: loc('u_size'), pad: loc('u_pad'), tex: loc('u_tex'), b: loc('u_b') },
      vbo: gl.createBuffer(),
      ibo: gl.createBuffer(),
      tex: gl.createTexture(),
      key: null,
    };
  } catch {
    return null;
  }
}

/** Upload the basemap as a texture and the terrain as a shaded grid mesh. */
function upload(s, basemap, terrain, base) {
  const { gl } = s;
  const W = basemap.canvas.width;
  const H = basemap.canvas.height;
  s.canvas.width = W;
  s.canvas.height = H;
  // The mesh covers the wide map: x from -P to W + P, y from -P to H + P.
  const P = basemap.wide?.pad ?? 0;
  const TW = W + P * 2;
  const TH = H + P * 2;

  gl.bindTexture(gl.TEXTURE_2D, s.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, basemap.wide?.canvas ?? basemap.canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // 16-bit indices: keep the grid under 65,536 vertices.
  let cols = COLS;
  let rows = Math.max(2, Math.round((cols * TH) / TW));
  while ((cols + 1) * (rows + 1) > 65535) {
    cols = Math.floor(cols * 0.9);
    rows = Math.max(2, Math.round((cols * TH) / TW));
  }
  const dx = TW / cols;
  const dy = TH / rows;
  const h = new Float32Array((cols + 1) * (rows + 1));
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) h[j * (cols + 1) + i] = terrain.heightAt(i * dx - P, j * dy - P) - base;

  // Hillshade from a sun in the north-west, so relief reads even on flat-looking imagery.
  const k = terrain.pxPerMeter * EXAGGERATION;
  const L = [-0.6, 0.8, -0.5];
  const ll = Math.hypot(...L);
  const at = (i, j) => h[clamp(j, 0, rows) * (cols + 1) + clamp(i, 0, cols)];
  const verts = new Float32Array(h.length * 4);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const nx = (-(at(i + 1, j) - at(i - 1, j)) * k) / (2 * dx);
      const nz = (-(at(i, j + 1) - at(i, j - 1)) * k) / (2 * dy);
      const dot = (nx * L[0] + L[1] + nz * L[2]) / (Math.hypot(nx, 1, nz) * ll);
      const v = (j * (cols + 1) + i) * 4;
      verts[v] = i * dx - P;
      verts[v + 1] = j * dy - P;
      verts[v + 2] = at(i, j);
      verts[v + 3] = clamp(0.5 + 0.7 * dot, 0.35, 1.3);
    }
  }
  const idx = new Uint16Array(cols * rows * 6);
  let p = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i;
      const b = a + cols + 1;
      idx.set([a, b, a + 1, a + 1, b, b + 1], p);
      p += 6;
    }
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, s.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  s.count = idx.length;
}

/* column-major 4×4 matrices */
function perspective(fovy, aspect, n, f) {
  const t = 1 / Math.tan(fovy / 2);
  return [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, (2 * f * n) / (n - f), 0];
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};
function lookAt(eye, center, up) {
  const z = norm(sub(eye, center));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1];
}
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}

/**
 * A 3D view of the basemap draped over the terrain. Heights are meters above `base`.
 * Returns null when WebGL isn't available.
 */
export function getTerrainView(basemap, terrain, base) {
  if (shared === undefined) shared = initGL();
  if (!shared) return null;
  const s = shared;
  const W = basemap.canvas.width;
  const H = basemap.canvas.height;
  const heightAt = (x, y) => terrain.heightAt(x, y) - base;
  const P = basemap.wide?.pad ?? 0; // map margin past the frame on every side
  const D0 = H / 2 / Math.tan(FOV / 2); // camera distance at which the flat map fills the frame 1:1
  let cam = null;
  // Lowest and highest ground on the map.
  const reliefRange = { min: Infinity, max: -Infinity };
  for (let j = 0; j <= 64; j++) {
    for (let i = 0; i <= 64; i++) {
      const h = heightAt((i / 64) * (W + P * 2) - P, (j / 64) * (H + P * 2) - P);
      reliefRange.min = Math.min(reliefRange.min, h);
      reliefRange.max = Math.max(reliefRange.max, h);
    }
  }

  const ensure = () => {
    if (s.key?.basemap !== basemap || s.key?.terrain !== terrain || s.key?.base !== base) {
      upload(s, basemap, terrain, base);
      s.key = { basemap, terrain, base };
    }
  };

  return {
    heightAt,
    /**
     * b = 0: straight down at the whole map, pixel-identical to the 2D map (and flat).
     * b = 1: tilted, zoomed-in camera aimed at (x, y), orbiting by `heading` (radians).
     */
    setCamera({ b, x, y, heading }) {
      const hk = EXAGGERATION * terrain.pxPerMeter * b;
      const phi = lerp(Math.PI / 2, PITCH, b);
      const th = heading * b;
      // "Up" is the horizontal look direction, which keeps north up when looking straight down.
      const up = [-Math.sin(th), 0, -Math.cos(th)];
      // Aim a little ahead of the hiker along the look direction, so the hiker sits low in the
      // frame with the way ahead above. Scales with the camera distance D.
      const aimFor = (D) => [lerp(W / 2, x - Math.sin(th) * D * LEAD, b), lerp(H / 2, y - Math.cos(th) * D * LEAD, b)];

      // Ground area the frame can show, relative to a target at height hT, for a camera D away.
      // The ground can sit anywhere from the map's lowest to its highest point: low ground lets
      // the far edge of the frame reach farther out, high ground the near edge.
      const footprint = (D, hT) => {
        const levels = [(reliefRange.min - hT) * hk, (reliefRange.max - hT) * hk];
        const off = [D * Math.sin(th) * Math.cos(phi), D * Math.sin(phi), D * Math.cos(th) * Math.cos(phi)];
        const zc = norm(off);
        const xc = norm(cross(up, zc));
        const yc = cross(zc, xc);
        const ty = Math.tan(FOV / 2);
        const tx = ty * (W / H);
        const fp = { off, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const d = [0, 1, 2].map((i) => xc[i] * sx * tx + yc[i] * sy * ty - zc[i]);
          for (const level of levels) {
            // A ray above the horizon (or one that never comes down to this level) never lands.
            const s = d[1] < -1e-6 && off[1] > level ? (level - off[1]) / d[1] : 1e6;
            fp.x0 = Math.min(fp.x0, off[0] + s * d[0]);
            fp.x1 = Math.max(fp.x1, off[0] + s * d[0]);
            fp.z0 = Math.min(fp.z0, off[2] + s * d[2]);
            fp.z1 = Math.max(fp.z1, off[2] + s * d[2]);
          }
        }
        return fp;
      };
      // Keep that area on the (wide) map so nothing beyond its edge shows: slide the aim point a
      // little if needed, and otherwise move in closer, which keeps the hiker in the frame.
      const keepIn = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : clamp(v, lo, hi));
      // Fit for distance D: where to aim, and how far that had to slide from the ideal aim.
      const place = (D) => {
        const [ax, az] = aimFor(D);
        // Aim at the hiker's own height (not the ground ahead, which may be far downhill from a
        // summit), so the hiker stays put in the frame.
        const hT = heightAt(lerp(W / 2, x, b), lerp(H / 2, y, b));
        const fp = footprint(D, hT);
        const cx = keepIn(ax, -P - fp.x0, W + P - fp.x1);
        const cz = keepIn(az, -P - fp.z0, H + P - fp.z1);
        const fit = Math.min((W + P * 2) / (fp.x1 - fp.x0), (H + P * 2) / (fp.z1 - fp.z0));
        return { cx, cz, hT, fp, fit, slide: Math.hypot(cx - ax, cz - az) };
      };
      let D = lerp(D0, D0 * CLOSE, b);
      let pl = place(D);
      for (let i = 0; i < 12; i++) {
        if (pl.fit < 0.9999) D *= pl.fit;
        else if (pl.slide > D * MAX_SLIDE) D *= 0.85;
        else break;
        pl = place(D);
      }
      const { cx, cz, hT, fp } = pl;

      const { off } = fp;
      const target = [cx, hT * hk, cz];
      const eye = [target[0] + off[0], target[1] + off[1], target[2] + off[2]];
      const vp = mul(perspective(FOV, W / H, D * 0.05, D * 8), lookAt(eye, target, up));
      cam = { b, hk, vp };
    },
    /** Basemap pixel (x, y) at `h` meters → output pixel, plus depth (≤ 0: behind the camera). */
    project(x, y, h) {
      const m = cam.vp;
      const Y = h * cam.hk;
      const depth = m[3] * x + m[7] * Y + m[11] * y + m[15];
      const w = Math.max(1e-3, depth);
      return [
        (((m[0] * x + m[4] * Y + m[8] * y + m[12]) / w + 1) / 2) * W,
        ((1 - (m[1] * x + m[5] * Y + m[9] * y + m[13]) / w) / 2) * H,
        depth,
      ];
    },
    render() {
      ensure();
      const { gl, u } = s;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(s.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.vbo);
      gl.enableVertexAttribArray(s.aV);
      gl.vertexAttribPointer(s.aV, 4, gl.FLOAT, false, 16, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.ibo);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, s.tex);
      gl.uniform1i(u.tex, 0);
      gl.uniformMatrix4fv(u.vp, false, cam.vp);
      gl.uniform1f(u.hk, cam.hk);
      gl.uniform2f(u.size, W + P * 2, H + P * 2);
      gl.uniform1f(u.pad, P);
      gl.uniform1f(u.b, cam.b);
      gl.drawElements(gl.TRIANGLES, s.count, gl.UNSIGNED_SHORT, 0);
      return s.canvas;
    },
  };
}

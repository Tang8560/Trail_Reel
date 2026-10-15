import exifr from 'exifr';
import { readVideoMeta } from './mp4meta';

const MAX_PHOTO_SIDE = 2048;
let nextId = 1;

// Large videos stay file-backed: copying them would eat into the iPhone tab memory limit.
const MAX_IN_MEMORY = 64 * 1024 * 1024;

/**
 * Copy a picked file into memory, retrying transient read failures. Safari/WebKit can fail to
 * read picker-backed Files (NotFoundError / NotReadableError), especially once the input is
 * reset; an in-memory copy is always readable afterwards. Huge videos stay file-backed.
 */
export async function readIntoMemory(file, attempts = 6) {
  if (file.size > MAX_IN_MEMORY) return file;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const buf = await file.arrayBuffer();
      return new File([buf], file.name, { type: file.type, lastModified: file.lastModified });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw new Error(`Could not read the file (${lastErr?.name || 'unknown error'}). Try selecting it again.`);
}

export function kindOf(file) {
  const n = file.name.toLowerCase();
  if (n.endsWith('.gpx')) return 'gpx';
  if (/\.(heic|heif)$/.test(n) || /heic|heif/.test(file.type)) return 'heic';
  if (file.type.startsWith('image/') || /\.(jpe?g|png|webp|avif|gif)$/.test(n)) return 'image';
  if (file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/.test(n)) return 'video';
  if (file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|flac)$/.test(n)) return 'audio';
  return null;
}

/** EXIF date → UTC ms, honouring OffsetTimeOriginal when the camera recorded it. */
function exifTime(exif) {
  const d = exif?.DateTimeOriginal || exif?.CreateDate || exif?.ModifyDate;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  const off = exif.OffsetTimeOriginal || exif.OffsetTime;
  const m = typeof off === 'string' && off.match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!m) return d.getTime();
  const mins = (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  return (
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) -
    mins * 60000
  );
}

function decodeWithImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ src: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image decode failed'));
    };
    img.src = url;
  });
}

/**
 * Decode any supported image to a drawable source. Safari/iOS decodes HEIC natively in <img>;
 * other browsers fall back to heic2any (loaded on demand).
 */
async function decodeImage(file, kind) {
  try {
    return await decodeWithImg(file);
  } catch (e) {
    if (kind !== 'heic') throw e;
    const { default: heic2any } = await import('heic2any');
    const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    return decodeWithImg(Array.isArray(out) ? out[0] : out);
  }
}

// One reusable scratch canvas: iOS caps total canvas memory, so we never keep large canvases.
let scratch = null;
function toJpeg(src, w, h, quality = 0.9) {
  scratch ||= document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  scratch.getContext('2d').drawImage(src, 0, 0, w, h);
  return new Promise((r) => scratch.toBlob(r, 'image/jpeg', quality)).finally(() => {
    scratch.width = scratch.height = 1;
  });
}

function makeThumb(src, sw, sh, size = 240) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const s = Math.max(size / sw, size / sh);
  c.getContext('2d').drawImage(src, (size - sw * s) / 2, (size - sh * s) / 2, sw * s, sh * s);
  return c;
}

const canvasUrl = (c) =>
  new Promise((r) => c.toBlob((b) => r(URL.createObjectURL(b)), 'image/jpeg', 0.85));

async function loadPhoto(file, kind) {
  let exif = null;
  try {
    exif = await exifr.parse(file, { tiff: true, exif: true, gps: true });
  } catch {
    /* no EXIF */
  }
  const img = await decodeImage(file, kind);
  const s = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.width, img.height));
  const width = Math.round(img.width * s);
  const height = Math.round(img.height * s);
  // Keep a compact JPEG and decode it only while it's on screen (see getPhotoBitmap).
  const blob = await toJpeg(img.src, width, height);
  const thumbCanvas = makeThumb(img.src, img.width, img.height);
  img.done();
  const time = exifTime(exif);
  return {
    id: nextId++,
    kind: 'photo',
    name: file.name,
    blob,
    bitmap: null,
    width,
    height,
    time: time ?? file.lastModified,
    timeSource: time != null ? 'EXIF' : 'file date',
    lat: Number.isFinite(exif?.latitude) ? exif.latitude : null,
    lon: Number.isFinite(exif?.longitude) ? exif.longitude : null,
    thumbCanvas,
    thumb: await canvasUrl(thumbCanvas),
  };
}

export async function getPhotoBitmap(item) {
  item._decoding ||= createImageBitmap(item.blob);
  item.bitmap = await item._decoding;
  return item.bitmap;
}

export function releasePhotoBitmap(item) {
  item._decoding?.then((b) => b.close?.());
  item._decoding = null;
  item.bitmap = null;
}

function once(el, ok, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => cleanup(reject(new Error('Timed out loading video'))), timeoutMs);
    const onOk = () => cleanup(resolve());
    const onErr = () => cleanup(reject(new Error('This browser cannot decode the video')));
    const cleanup = () => {
      clearTimeout(t);
      el.removeEventListener(ok, onOk);
      el.removeEventListener('error', onErr);
    };
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onErr);
  });
}

export async function seekVideo(video, t) {
  if (Math.abs(video.currentTime - t) < 0.02 && video.readyState >= 2) return;
  const p = once(video, 'seeked', 5000).catch(() => {});
  video.currentTime = t;
  await p;
}

async function loadVideo(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  // iOS won't buffer frames until playback starts; a muted play is allowed without a tap.
  video.muted = true;
  const ready = once(video, 'loadedmetadata');
  video.src = url;
  try {
    await ready;
    if (video.readyState < 2) {
      await video.play().catch(() => {});
      video.pause();
      if (video.readyState < 2) await once(video, 'loadeddata', 8000);
    }
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  const meta = await readVideoMeta(file).catch(() => ({}));
  await seekVideo(video, Math.min(1, video.duration / 3));
  const thumbCanvas = makeThumb(video, video.videoWidth, video.videoHeight);
  await seekVideo(video, 0);
  return {
    id: nextId++,
    kind: 'video',
    name: file.name,
    url,
    video,
    width: video.videoWidth,
    height: video.videoHeight,
    duration: video.duration,
    time: meta.time ?? file.lastModified,
    timeSource: meta.time != null ? 'metadata' : 'file date',
    lat: meta.lat ?? null,
    lon: meta.lon ?? null,
    thumbCanvas,
    thumb: await canvasUrl(thumbCanvas),
  };
}

export function loadMedia(file) {
  const kind = kindOf(file);
  if (kind === 'video') return loadVideo(file);
  if (kind === 'heic' || kind === 'image') return loadPhoto(file, kind);
  return Promise.reject(new Error(`Unsupported file: ${file.name}`));
}

export function disposeMedia(item) {
  if (item.thumb) URL.revokeObjectURL(item.thumb);
  if (item.url) URL.revokeObjectURL(item.url);
  releasePhotoBitmap(item);
  if (item.video) {
    item.video.pause();
    item.video.removeAttribute('src');
    item.video.load();
  }
}

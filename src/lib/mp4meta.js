// Minimal MP4/MOV metadata reader: creation time and ISO-6709 location (iPhone, Android, GoPro).

const MP4_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01
const MAX_MOOV = 64 * 1024 * 1024;

async function readBytes(file, start, len) {
  return new Uint8Array(await file.slice(start, start + len).arrayBuffer());
}

const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function indexOf(bytes, str) {
  const c = [...str].map((ch) => ch.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - c.length; i++) {
    for (let j = 0; j < c.length; j++) if (bytes[i + j] !== c[j]) continue outer;
    return i;
  }
  return -1;
}

async function findMoov(file) {
  let off = 0;
  while (off + 8 <= file.size) {
    const h = await readBytes(file, off, 16);
    let size = u32(h, 0);
    const type = fourcc(h, 4);
    if (size === 1) size = u32(h, 8) * 2 ** 32 + u32(h, 12);
    else if (size === 0) size = file.size - off;
    if (size < 8) return null;
    if (type === 'moov') return size > MAX_MOOV ? null : readBytes(file, off, size);
    off += size;
  }
  return null;
}

export async function readVideoMeta(file) {
  const moov = await findMoov(file);
  if (!moov) return {};
  const res = {};

  const mvhd = indexOf(moov, 'mvhd');
  if (mvhd >= 0) {
    const v = moov[mvhd + 4];
    const secs = v === 1 ? u32(moov, mvhd + 8) * 2 ** 32 + u32(moov, mvhd + 12) : u32(moov, mvhd + 8);
    const ms = (secs - MP4_EPOCH_OFFSET) * 1000;
    if (ms > Date.UTC(2000, 0, 1)) res.time = ms;
  }

  const text = new TextDecoder('latin1').decode(moov);
  // Apple's com.apple.quicktime.creationdate carries the real timezone; prefer it.
  const cd = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:?\d{2}|Z)/);
  if (cd) {
    const t = Date.parse(cd[0].replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (Number.isFinite(t)) res.time = t;
  }
  const loc = text.match(/([+-]\d{1,2}\.\d{3,})([+-]\d{1,3}\.\d{3,})/);
  if (loc) {
    const lat = parseFloat(loc[1]);
    const lon = parseFloat(loc[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) Object.assign(res, { lat, lon });
  }
  return res;
}

// On-device music generator: composes a cheerful, major-key hiking tune (chords, melody,
// bass, percussion) from music-theory rules and a random seed, renders it with an
// OfflineAudioContext (faster than real time) and returns a WAV file. Nothing leaves the
// device and every tune is royalty-free. Same style + seed + length => same tune.

export const MUSIC_STYLES = {
  sunnyTrail: {
    label: 'Sunny Trail',
    icon: '☀️',
    desc: 'Bright ukulele strums and a whistled tune',
    bpm: 112,
    swing: 0,
    keys: [60, 62, 67], // C, D, G
    rhythm: 'strum',
    lead: 'whistle',
    drums: 'pop',
    pad: false,
  },
  meadowStroll: {
    label: 'Meadow Stroll',
    icon: '🌼',
    desc: 'Bouncy folk walk with handclaps',
    bpm: 104,
    swing: 0.2,
    keys: [65, 67, 62], // F, G, D
    rhythm: 'strum',
    lead: 'whistle+bell',
    drums: 'folk',
    pad: false,
  },
  summitMorning: {
    label: 'Summit Morning',
    icon: '🏔️',
    desc: 'Uplifting, builds to a big sunny finish',
    bpm: 96,
    swing: 0,
    keys: [62, 64, 60], // D, E, C
    rhythm: 'arp',
    lead: 'bell',
    drums: 'build',
    pad: true,
  },
  goldenHour: {
    label: 'Golden Hour',
    icon: '🌅',
    desc: 'Warm, relaxed fingerpicked guitar',
    bpm: 84,
    swing: 0.12,
    keys: [67, 65, 60], // G, F, C
    rhythm: 'pick',
    lead: 'bell-soft',
    drums: 'light',
    pad: true,
  },
};

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
// Happy progressions as scale degrees (0 = I, 3 = IV, 4 = V, 5 = vi, 1 = ii, 2 = iii)
const PROG_VERSE = [
  [0, 4, 5, 3],
  [0, 3, 4, 3],
  [0, 5, 3, 4],
  [0, 3, 0, 4],
];
const PROG_CHORUS = [
  [3, 4, 0, 5],
  [3, 0, 4, 0],
  [5, 3, 0, 4],
  [3, 4, 2, 5],
];
// Melody rhythms in eighth notes; negative = rest
const MOTIFS = [
  [2, 2, 2, 2],
  [2, 1, 1, 2, 2],
  [1, 1, 2, 1, 1, 2],
  [3, 1, 2, 2],
  [2, 2, 4],
  [1, 1, 1, 1, 2, 2],
  [-2, 1, 1, 2, 2],
  [2, 1, 1, 4],
];
const CADENCES = [
  [2, 2, 4],
  [4, 4],
  [2, 6],
  [1, 1, 2, 4],
];

const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

/* ───────────────────────── theory helpers ───────────────────────── */

const scaleNote = (key, degree) => key + MAJOR[((degree % 7) + 7) % 7] + 12 * Math.floor(degree / 7);
const chordPcs = (key, deg) => [0, 2, 4].map((s) => scaleNote(key, deg + s) % 12);

/** Guitar-ish 4-note voicing with the root between E3 and D#4. */
function voicing(key, deg) {
  let root = scaleNote(key, deg);
  while (root > 63) root -= 12;
  while (root < 52) root += 12;
  const third = scaleNote(key, deg + 2) - scaleNote(key, deg);
  const fifth = scaleNote(key, deg + 4) - scaleNote(key, deg);
  return [root, root + fifth, root + 12, root + 12 + third];
}

function bassNote(key, deg, interval = 0) {
  let n = scaleNote(key, deg + interval);
  while (n > 47) n -= 12;
  while (n < 36) n += 12;
  return n;
}

/** Melody pitch pool: the major scale across ~1.5 octaves above the key. */
function melodyPool(key, lift) {
  const pool = [];
  for (let d = -2; d <= 11; d++) pool.push(scaleNote(key, d) + lift);
  return pool;
}

/**
 * A 4-bar phrase: motif, answer, motif again (new pitches), cadence. Strong beats land on
 * chord tones, everything else moves by small steps — that's what makes it singable.
 */
function makePhrase(rng, key, prog, lift, endOnRoot) {
  const pool = melodyPool(key, lift);
  const m1 = pick(rng, MOTIFS);
  const m2 = pick(rng, MOTIFS);
  const rhythms = [m1, m2, m1, pick(rng, CADENCES)];
  let idx = 4 + Math.floor(rng() * 3);
  const notes = [];
  rhythms.forEach((motif, bar) => {
    const pcs = chordPcs(key, prog[bar]);
    let pos = 0;
    motif.forEach((len, i) => {
      const dur = Math.abs(len);
      if (len > 0) {
        const strong = pos % 4 === 0;
        const lastNote = bar === 3 && i === motif.length - 1;
        // contour: rise through the first half, settle back down at the end
        const bias = bar < 2 ? 0.6 : 0.35;
        if (strong || lastNote) {
          const wantRoot = lastNote && endOnRoot;
          let best = idx;
          let bestCost = Infinity;
          pool.forEach((p, j) => {
            const pc = p % 12;
            if (wantRoot ? pc !== scaleNote(key, prog[bar]) % 12 : !pcs.includes(pc)) return;
            // stay close; lean upward early in the phrase and downward towards the cadence
            const against = bias > 0.5 ? j < idx : j > idx;
            const cost = Math.abs(j - idx) + (against ? 0.5 : 0) + rng() * 0.8;
            if (cost < bestCost) {
              bestCost = cost;
              best = j;
            }
          });
          idx = best;
        } else {
          const r = rng();
          const step = r < 0.12 ? 0 : r < 0.82 ? 1 : 2;
          idx += rng() < bias ? step : -step;
          idx = Math.max(1, Math.min(pool.length - 2, idx));
        }
        notes.push({ bar, pos, len: dur, midi: pool[idx] });
      }
      pos += dur;
    });
  });
  return notes;
}

/* ──────────────── synth voices (used to make the samples) ──────────────── */

function envGain(ctx, out, t, peak, attack, decay, sustain = 0.0001, hold = 0) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  if (hold) g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), t + attack + hold + decay);
  g.connect(out);
  return g;
}

function panned(ctx, out, pan) {
  if (!ctx.createStereoPanner) return out;
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  p.connect(out);
  return p;
}

/** Plucked string (ukulele / guitar): bright attack, filter closes as it decays. */
function synthPluck(ctx, out, t, midi, vel, { decay = 0.9, bright = 1, pan = 0 } = {}) {
  const f = mtof(midi);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.8;
  lp.frequency.setValueAtTime(Math.min(9000, 1800 + f * 6 * bright), t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(300, f * 1.5), t + decay * 0.5);
  const g = envGain(ctx, panned(ctx, out, pan), t, vel, 0.004, decay);
  lp.connect(g);
  const o1 = ctx.createOscillator();
  o1.type = 'triangle';
  o1.frequency.value = f;
  const o2 = ctx.createOscillator();
  o2.type = 'sawtooth';
  o2.frequency.value = f * 1.003;
  const g2 = ctx.createGain();
  g2.gain.value = 0.35;
  o1.connect(lp);
  o2.connect(g2).connect(lp);
  const end = t + decay + 0.05;
  for (const o of [o1, o2]) {
    o.start(t);
    o.stop(end);
  }
}

/** Glockenspiel / music box: sine with an inharmonic shimmer. */
function synthBell(ctx, out, t, midi, vel, { decay = 1.4, pan = 0.25 } = {}) {
  const f = mtof(midi);
  const dest = panned(ctx, out, pan);
  [
    [1, 1, decay],
    [2.76, 0.28, decay * 0.4],
    [5.4, 0.12, decay * 0.2],
  ].forEach(([ratio, amp, d]) => {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f * ratio;
    o.connect(envGain(ctx, dest, t, vel * amp, 0.002, d));
    o.start(t);
    o.stop(t + d + 0.05);
  });
}

/** Whistle: pure tone with delayed vibrato and a soft breathy attack. */
function whistle(ctx, out, t, midi, dur, vel) {
  const f = mtof(midi);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(f * 0.985, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
  if (dur > 0.25) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const depth = ctx.createGain();
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(f * 0.006, t + Math.min(0.3, dur));
    lfo.connect(depth).connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + dur + 0.15);
  }
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.035);
  g.gain.setValueAtTime(vel * 0.85, t + Math.max(0.04, dur - 0.06));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
  o.connect(g).connect(panned(ctx, out, -0.1));
  o.start(t);
  o.stop(t + dur + 0.15);
}

function bass(ctx, out, t, midi, dur, vel) {
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = mtof(midi);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.008);
  g.gain.exponentialRampToValueAtTime(vel * 0.5, t + 0.25);
  g.gain.setValueAtTime(vel * 0.5, t + Math.max(0.26, dur - 0.05));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
  o.connect(lp).connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.1);
}

function pad(ctx, out, t, notes, dur, vel) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1400;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vel, t + dur * 0.35);
  g.gain.setValueAtTime(vel, t + dur * 0.7);
  g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.3);
  lp.connect(g).connect(out);
  for (const m of notes) {
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(m);
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.35);
    }
  }
}

function noiseHit(ctx, out, noise, t, { type = 'highpass', freq = 6000, q = 0.7, vel = 0.2, decay = 0.06, pan = 0 }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  src.connect(f).connect(envGain(ctx, panned(ctx, out, pan), t, vel, 0.001, decay));
  src.start(t, 0.1);
  src.stop(t + decay + 0.05);
}

function synthKick(ctx, out, t, vel) {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(130, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  o.connect(envGain(ctx, out, t, vel, 0.002, 0.28));
  o.start(t);
  o.stop(t + 0.35);
}

function synthClap(ctx, out, noise, t, vel) {
  for (const dt of [0, 0.011, 0.023]) {
    noiseHit(ctx, out, noise, t + dt, { type: 'bandpass', freq: 1400, q: 0.9, vel: vel * (dt ? 0.7 : 1), decay: dt === 0.023 ? 0.16 : 0.03 });
  }
}

function impulseResponse(ctx, seconds = 2) {
  const nrng = mulberry32(0x5eed);
  const len = Math.floor(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (nrng() * 2 - 1) * (1 - i / len) ** 3;
  }
  return ir;
}

function noiseBuffer(ctx) {
  const nrng = mulberry32(0xbeef);
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  buf.getChannelData(0).forEach((_, i, d) => (d[i] = nrng() * 2 - 1));
  return buf;
}

/* ───────────────── sampler: each sound rendered once, replayed per note ───────────────── */
// Synthesizing every note with its own moving filter is far too slow on a phone; rendering
// each instrument once and replaying it at the right pitch is many times faster.

const SAMPLE_DEFS = {
  pluck: { bases: [48, 64], len: 1.1, make: (c, o, t, m) => synthPluck(c, o, t, m, 1, { decay: 0.9 }) },
  pluckShort: { bases: [48, 64], len: 0.5, make: (c, o, t, m) => synthPluck(c, o, t, m, 1, { decay: 0.4 }) },
  pluckSoft: { bases: [48, 64], len: 1.2, make: (c, o, t, m) => synthPluck(c, o, t, m, 1, { decay: 1.0, bright: 0.6 }) },
  pluckLong: { bases: [48, 64], len: 2.8, make: (c, o, t, m) => synthPluck(c, o, t, m, 1, { decay: 2.6 }) },
  bell: { bases: [72, 84], len: 1.6, make: (c, o, t, m) => synthBell(c, o, t, m, 1, { decay: 1.4, pan: 0 }) },
  bellLong: { bases: [72, 84], len: 2.6, make: (c, o, t, m) => synthBell(c, o, t, m, 1, { decay: 2.4, pan: 0 }) },
  kick: { len: 0.4, make: (c, o, t) => synthKick(c, o, t, 1) },
  clap: { len: 0.3, make: (c, o, t) => synthClap(c, o, noiseBuffer(c), t, 1) },
  shaker: { len: 0.1, make: (c, o, t) => noiseHit(c, o, noiseBuffer(c), t, { freq: 6000, vel: 1, decay: 0.05 }) },
  tambourine: { len: 0.12, make: (c, o, t) => noiseHit(c, o, noiseBuffer(c), t, { freq: 7500, vel: 1, decay: 0.07 }) },
  snap: { len: 0.1, make: (c, o, t) => noiseHit(c, o, noiseBuffer(c), t, { type: 'bandpass', freq: 2500, q: 2, vel: 1, decay: 0.04 }) },
};

async function buildKit(Ctx, sampleRate) {
  const jobs = [];
  for (const [name, def] of Object.entries(SAMPLE_DEFS)) {
    for (const base of def.bases || [null]) {
      const c = new Ctx(2, Math.ceil(def.len * sampleRate), sampleRate);
      def.make(c, c.destination, 0.002, base);
      jobs.push(render(c).then((buf) => ({ name, base, buf })));
    }
  }
  const samples = {};
  for (const { name, base, buf } of await Promise.all(jobs)) (samples[name] ||= []).push({ base, buf });
  return { samples };
}

const kits = new WeakMap();

function play(ctx, out, name, t, midi, vel, pan = 0) {
  const kit = kits.get(ctx);
  const variants = kit.samples[name];
  const v = midi == null ? variants[0] : variants.reduce((a, b) => (Math.abs(b.base - midi) < Math.abs(a.base - midi) ? b : a));
  const src = ctx.createBufferSource();
  src.buffer = v.buf;
  if (midi != null) src.playbackRate.value = 2 ** ((midi - v.base) / 12);
  const g = ctx.createGain();
  g.gain.value = vel;
  let dest = kit.pans.get(pan);
  if (!dest) {
    dest = panned(ctx, out, pan);
    kit.pans.set(pan, dest);
  }
  src.connect(g).connect(dest);
  src.start(t);
}

function pluck(ctx, out, t, midi, vel, { decay = 0.9, bright = 1, pan = 0 } = {}) {
  const name = decay >= 2 ? 'pluckLong' : decay <= 0.45 ? 'pluckShort' : bright < 0.9 ? 'pluckSoft' : 'pluck';
  play(ctx, out, name, t, midi, vel, pan);
}
const bell = (ctx, out, t, midi, vel, { decay = 1.4, pan = 0.25 } = {}) => play(ctx, out, decay > 2 ? 'bellLong' : 'bell', t, midi, vel, pan);
const kick = (ctx, out, t, vel) => play(ctx, out, 'kick', t, null, vel);
const clap = (ctx, out, t, vel) => play(ctx, out, 'clap', t, null, vel);
const shaker = (ctx, out, t, vel, bright) => play(ctx, out, bright ? 'tambourine' : 'shaker', t, null, vel, 0.35);
const snap = (ctx, out, t, vel) => play(ctx, out, 'snap', t, null, vel);

/* ───────────────────────── arrangement ───────────────────────── */

function planSong(rng, style, totalBars) {
  const key = pick(rng, style.keys);
  const verse = pick(rng, PROG_VERSE);
  const chorus = pick(rng, PROG_CHORUS);
  const melA = makePhrase(rng, key, verse, 0, false);
  const melA2 = melA.filter((n) => n.bar < 3).concat(makePhrase(rng, key, verse, 0, true).filter((n) => n.bar === 3));
  const melB = makePhrase(rng, key, chorus, 2, false);
  const melB2 = melB.filter((n) => n.bar < 3).concat(makePhrase(rng, key, [...chorus.slice(0, 3), 0], 2, true).filter((n) => n.bar === 3));

  const bars = [];
  const push = (chord, section, melody, bar) => bars.push({ chord, section, melody: melody ? melody.filter((n) => n.bar === bar) : [] });
  push(0, 'intro', null, 0);
  push(chorus[0] === 0 ? 4 : 3, 'intro', null, 1);
  const order = [
    ['A', verse, melA],
    ['A', verse, melA2],
    ['B', chorus, melB],
    ['B', chorus, melB2],
  ];
  for (let k = 0; bars.length < totalBars - 1; k++) {
    const [section, prog, mel] = order[k % order.length];
    for (let b = 0; b < 4 && bars.length < totalBars - 1; b++) push(prog[b], section, mel, b);
  }
  bars.push({ chord: 0, section: 'end', melody: [] });
  return { key, bars };
}

/* ───────────────────────── render ───────────────────────── */

function offlineCtor() {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('This browser cannot generate music (no Web Audio)');
  return Ctx;
}

function pickSampleRate(Ctx) {
  for (const rate of [32000, 44100]) {
    try {
      new Ctx(2, rate, rate);
      return rate;
    } catch {
      /* try the next sample rate */
    }
  }
  throw new Error('Could not start the music generator');
}

/** Mixer for one chunk: instruments → bus → (dry + reverb) → gentle compressor. */
function chunkGraph(Ctx, sampleRate, seconds, kit, ir, reverbAmount) {
  const ctx = new Ctx(2, Math.ceil(seconds * sampleRate), sampleRate);
  kits.set(ctx, { samples: kit.samples, pans: new Map() });
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.2;
  comp.connect(ctx.destination);
  const bus = ctx.createGain();
  bus.gain.value = 0.8;
  bus.connect(comp);
  const verb = ctx.createConvolver();
  verb.buffer = ir;
  const send = ctx.createGain();
  send.gain.value = reverbAmount;
  bus.connect(send).connect(verb).connect(comp);
  return { ctx, bus };
}

function render(ctx) {
  return new Promise((resolve, reject) => {
    const p = ctx.startRendering();
    if (p?.then) p.then(resolve, reject);
    else ctx.oncomplete = (e) => resolve(e.renderedBuffer); // old Safari
  });
}

export async function composeMusic({ style: styleKey = 'sunnyTrail', seed = 1, seconds = 60 }) {
  const style = MUSIC_STYLES[styleKey] || MUSIC_STYLES.sunnyTrail;
  const rng = mulberry32(seed);
  const length = Math.max(8, seconds);
  const beat = 60 / style.bpm;
  const barDur = beat * 4;
  const eighth = beat / 2;
  const totalBars = Math.max(4, Math.round((length - 1) / barDur));
  const { key, bars } = planSong(rng, style, totalBars);

  const Ctx = offlineCtor();
  const sampleRate = pickSampleRate(Ctx);
  const kit = await buildKit(Ctx, sampleRate);
  const ir = impulseResponse(new Ctx(2, sampleRate, sampleRate), 2.2);
  const reverbAmount = style.rhythm === 'pick' ? 0.32 : 0.22;

  const human = () => (rng() - 0.5) * 0.012;
  const vary = (v) => v * (0.88 + rng() * 0.24);
  const slot = (barStart, i) => barStart + i * eighth + (i % 2 ? style.swing * eighth : 0);

  const scheduleBar = (ctx, bus, bar, n, t0) => {
    const voice = voicing(key, bar.chord);
    const next = bars[n + 1]?.chord ?? 0;
    const progress = n / bars.length;
    const intensity = style.drums === 'build' ? 0.35 + 0.65 * progress : bar.section === 'B' ? 1 : bar.section === 'A' ? 0.8 : 0.55;
    const chorus = bar.section === 'B';

    if (bar.section === 'end') {
      // Final chord, left to ring out.
      voice.forEach((m, i) => pluck(ctx, bus, t0 + i * 0.03, m, 0.16, { decay: 2.6, pan: -0.25 }));
      bass(ctx, bus, t0, bassNote(key, 0), barDur, 0.35);
      bell(ctx, bus, t0 + 0.05, scaleNote(key, 0) + 12, 0.18, { decay: 2.4 });
      kick(ctx, bus, t0, 0.5);
      if (style.pad) pad(ctx, bus, t0, voice.slice(0, 3), barDur, 0.035);
      return;
    }

    // ── rhythm instrument
    if (style.rhythm === 'strum') {
      const pattern = bar.section === 'intro' ? ['D', 0, 0, 0, 'D', 0, 'D', 'U'] : ['D', 0, 'D', 'U', 0, 'U', 'D', 'U'];
      pattern.forEach((s, i) => {
        if (!s) return;
        const t = slot(t0, i) + human();
        const strings = s === 'D' ? voice : [...voice].reverse().slice(0, 3);
        strings.forEach((m, k) =>
          pluck(ctx, bus, t + k * 0.012, m, vary(s === 'D' ? 0.11 : 0.07) * intensity, { decay: s === 'D' ? 0.7 : 0.4, pan: -0.3 })
        );
      });
    } else if (style.rhythm === 'arp') {
      [0, 1, 2, 3, 2, 1, 2, 3].forEach((v, i) =>
        pluck(ctx, bus, slot(t0, i) + human(), voice[v] + 12, vary(0.1) * (0.6 + intensity * 0.5), { decay: 1.1, bright: 0.8, pan: i % 2 ? 0.3 : -0.3 })
      );
    } else {
      // Travis-style fingerpicking: alternating bass with chord tones on the off-beats
      const low = [voice[0] - 12, voice[1] - 12];
      ['B', 'h', 'b', 'h', 'B', 'h', 'b', 'h'].forEach((s, i) => {
        const t = slot(t0, i) + human();
        if (s === 'B') pluck(ctx, bus, t, low[0], vary(0.15), { decay: 1.0, bright: 0.6, pan: -0.15 });
        else if (s === 'b') pluck(ctx, bus, t, low[1], vary(0.12), { decay: 0.9, bright: 0.6, pan: -0.15 });
        else pluck(ctx, bus, t, voice[2 + (i % 4 === 1 ? 0 : 1)], vary(0.08), { decay: 0.8, bright: 0.7, pan: 0.2 });
      });
    }

    // ── bass
    if (style.rhythm !== 'pick') {
      if (style.drums === 'folk') {
        // bouncy walking bass: root, fifth, octave, fifth
        const root = bassNote(key, bar.chord);
        const fifth = bassNote(key, bar.chord, 4);
        [root, fifth, root + 12, fifth].forEach((m, q) => bass(ctx, bus, t0 + q * beat + human(), m, beat * 0.8, vary(0.3)));
      } else {
        bass(ctx, bus, t0, bassNote(key, bar.chord), beat * 1.8, vary(0.34));
        bass(ctx, bus, t0 + 2 * beat, bassNote(key, bar.chord, 4), beat * 1.3, vary(0.28));
        if (rng() < 0.6) {
          // passing note leading into the next chord
          const target = bassNote(key, next);
          bass(ctx, bus, t0 + 3.5 * beat, target + (rng() < 0.5 ? 2 : -1), beat * 0.45, vary(0.24));
        }
      }
    } else {
      bass(ctx, bus, t0, bassNote(key, bar.chord), barDur * 0.9, 0.18);
    }

    // ── pad
    if (style.pad && (chorus || style.drums === 'build')) pad(ctx, bus, t0, voice.slice(0, 3), barDur, 0.03 * intensity);

    // ── drums
    const d = style.drums;
    for (let i = 0; i < 8; i++) {
      const t = slot(t0, i) + human() * 0.5;
      const onBeat = i % 2 === 0;
      const beatNo = i / 2;
      if (d === 'build' && intensity < 0.45) break;
      // shaker / tambourine on the eighths
      if (bar.section !== 'intro' || i % 2) {
        const shakeVel = (onBeat ? 0.05 : 0.09) * (d === 'light' ? 0.6 : 1) * intensity;
        shaker(ctx, bus, t, vary(shakeVel), d === 'folk');
      }
      // extra pickup kick on the "and" of 2 in pop choruses
      if (d === 'pop' && chorus && i === 3) kick(ctx, bus, t, 0.3);
      if (!onBeat) continue;
      const kickOn = d === 'build' ? intensity > 0.6 : d === 'light' ? beatNo === 0 : beatNo === 0 || beatNo === 2;
      if (kickOn) kick(ctx, bus, t, (d === 'light' ? 0.3 : 0.5) * intensity);
      const backbeat = beatNo === 1 || beatNo === 3;
      if (backbeat && bar.section !== 'intro') {
        if (d === 'folk' || (d === 'pop' && chorus) || (d === 'build' && intensity > 0.7)) clap(ctx, bus, t, vary(0.22) * intensity);
        else if (d === 'pop' || (d === 'light' && chorus)) snap(ctx, bus, t, 0.12);
      }
    }

    // ── melody
    for (const note of bar.melody) {
      const t = slot(t0, note.pos) + human();
      const dur = note.len * eighth * 0.95;
      const v = vary(0.16);
      if (style.lead === 'whistle' || style.lead === 'whistle+bell') {
        whistle(ctx, bus, t, note.midi + 12, dur, v * 0.9);
        if (style.lead === 'whistle+bell' && chorus) bell(ctx, bus, t, note.midi + 24, v * 0.35);
      } else {
        bell(ctx, bus, t, note.midi + 12, v * (style.lead === 'bell-soft' ? 0.7 : 1));
        if (chorus && style.lead === 'bell') pluck(ctx, bus, t, note.midi, v * 0.45, { decay: 0.6, pan: 0.1 });
      }
    }
    // a little sunshine sparkle on chorus bars
    if (chorus && style.lead === 'whistle' && rng() < 0.5) bell(ctx, bus, t0 + 3.5 * beat, voice[3] + 24, 0.06, { decay: 0.9, pan: 0.5 });
  };

  // Render in chunks of a few bars. An offline context processes every scheduled node on
  // every block until it ends, so one context holding a whole song's notes is very slow;
  // small chunks keep the node count low. Chunks overlap by their reverb tail when mixed.
  const LEAD_IN = 0.05; // keeps humanized timing of the very first notes above zero
  const CHUNK_BARS = 4;
  const TAIL = 2.8;
  const frames = Math.ceil(length * sampleRate);
  const mix = [new Float32Array(frames), new Float32Array(frames)];
  const jobs = [];
  for (let c0 = 0; c0 < bars.length && c0 * barDur < length; c0 += CHUNK_BARS) {
    const nBars = Math.min(CHUNK_BARS, bars.length - c0);
    const { ctx, bus } = chunkGraph(Ctx, sampleRate, nBars * barDur + TAIL + LEAD_IN, kit, ir, reverbAmount);
    for (let n = c0; n < c0 + nBars; n++) scheduleBar(ctx, bus, bars[n], n, LEAD_IN + (n - c0) * barDur);
    jobs.push({ offset: Math.round(c0 * barDur * sampleRate), ctx });
  }
  // Render two chunks at a time and mix each in as it finishes, to keep memory low.
  for (let i = 0; i < jobs.length; i += 2) {
    const done = await Promise.all(jobs.slice(i, i + 2).map((j) => render(j.ctx).then((buf) => ({ ...j, buf }))));
    for (const { offset, buf } of done) {
      for (let c = 0; c < 2; c++) {
        const src = buf.getChannelData(c);
        const dst = mix[c];
        const n = Math.min(src.length, frames - offset);
        for (let k = 0; k < n; k++) dst[offset + k] += src[k];
      }
    }
  }
  // Fade out over the last 2.5 s.
  const fadeFrames = Math.min(frames, Math.round(2.5 * sampleRate));
  for (let k = 0; k < fadeFrames; k++) {
    const g = k / fadeFrames;
    mix[0][frames - 1 - k] *= g;
    mix[1][frames - 1 - k] *= g;
  }
  const buffer = { numberOfChannels: 2, length: frames, sampleRate, duration: length, getChannelData: (c) => mix[c] };
  return { blob: encodeWav(buffer, loudnessGain(buffer)), duration: length, key, bpm: style.bpm };
}

/** Gain that brings every style to the same loudness without clipping. */
function loudnessGain(buffer, targetRms = 0.13) {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 4) {
      const x = Math.abs(d[i]);
      if (x > peak) peak = x;
      sum += x * x;
      n++;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  return rms > 0 ? Math.min(targetRms / rms, 0.95 / Math.max(peak, 1e-6)) : 1;
}

/** 16-bit PCM WAV. */
function encodeWav(buffer, gain = 1) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const data = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const writeStr = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  writeStr(0, 'RIFF');
  data.setUint32(4, 36 + frames * channels * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, channels, true);
  data.setUint32(24, buffer.sampleRate, true);
  data.setUint32(28, buffer.sampleRate * channels * 2, true);
  data.setUint16(32, channels * 2, true);
  data.setUint16(34, 16, true);
  writeStr(36, 'data');
  data.setUint32(40, frames * channels * 2, true);
  const chans = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i] * gain));
      data.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([data], { type: 'audio/wav' });
}

// One shared AudioContext: a media element can only ever be attached to a single context.
// Everything here degrades gracefully when Web Audio is missing (the video is then silent
// in the recording, but preview and rendering still work).
let state;
const elementGains = new WeakMap();

export function getAudio() {
  if (state === undefined) {
    const Ctx = window.AudioContext || window.webkitAudioContext; // older iOS: webkit prefix
    if (!Ctx) {
      state = null;
    } else {
      const ac = new Ctx();
      const dest = ac.createMediaStreamDestination?.() ?? null;
      const master = ac.createGain();
      if (dest) master.connect(dest);
      master.connect(ac.destination); // monitor through the speakers
      const musicBus = ac.createGain();
      musicBus.connect(master);
      state = { ac, dest, master, musicBus };
    }
  }
  return state;
}

/** Audio track to mix into the recording, if Web Audio can provide one. */
export function getRecordingAudioTrack() {
  return getAudio()?.dest?.stream.getAudioTracks()[0] ?? null;
}

function gainFor(el, bus) {
  let g = elementGains.get(el);
  if (!g) {
    const { ac } = getAudio();
    g = ac.createGain();
    ac.createMediaElementSource(el).connect(g);
    g.connect(bus);
    elementGains.set(el, g);
  }
  return g;
}

/**
 * iOS only allows audible playback for elements first played inside a user tap.
 * Call this synchronously from the click handler (before any await): it routes every
 * element into the (silenced) mix and plays/pauses it once, which unlocks it for later.
 */
export function unlockMedia(videos, musicEl) {
  const audio = getAudio();
  const els = [...videos, ...(musicEl ? [musicEl] : [])];
  if (audio) {
    audio.ac.resume();
    audio.master.gain.value = 0;
    videos.forEach((v) => gainFor(v, audio.master));
    if (musicEl) gainFor(musicEl, audio.musicBus);
  } else {
    els.forEach((el) => (el.volume = 0));
  }
  const plays = els.map((el) => {
    el.muted = false;
    return Promise.resolve(el.play()).then(
      () => el.pause(),
      () => {}
    );
  });
  return Promise.all(plays).then(() => {
    if (audio) audio.master.gain.value = 1;
    else els.forEach((el) => (el.volume = 1));
  });
}

export function routeVideo(video, volume) {
  const audio = getAudio();
  if (audio) gainFor(video, audio.master).gain.value = volume;
  else video.volume = volume;
}

export function createMusicController(musicEl, volume, { loop = true } = {}) {
  const audio = getAudio();
  if (!audio) return simpleMusicController(musicEl, volume, loop);
  const { ac, musicBus } = audio;
  if (musicEl) gainFor(musicEl, musicBus);
  const g = musicBus.gain;
  let held = false;
  return {
    async start() {
      g.cancelScheduledValues(ac.currentTime);
      g.setValueAtTime(volume, ac.currentTime);
      if (musicEl) {
        musicEl.loop = loop;
        musicEl.currentTime = 0;
        await musicEl.play().catch(() => {});
      }
    },
    duck(on) {
      g.cancelScheduledValues(ac.currentTime);
      g.setTargetAtTime(on ? volume * 0.2 : volume, ac.currentTime, 0.25);
    },
    fadeOut(sec) {
      g.cancelScheduledValues(ac.currentTime);
      g.setValueAtTime(g.value, ac.currentTime);
      g.linearRampToValueAtTime(0, ac.currentTime + sec);
    },
    pause() {
      held = !!musicEl && !musicEl.paused && !musicEl.ended;
      musicEl?.pause();
    },
    resume() {
      if (held) musicEl.play().catch(() => {});
      held = false;
    },
    stop() {
      musicEl?.pause();
    },
  };
}

/** Fallback without Web Audio: drive the element's own volume. */
function simpleMusicController(musicEl, volume, loop) {
  let fade = null;
  let held = false;
  const setVol = (v) => musicEl && (musicEl.volume = Math.max(0, Math.min(1, v)));
  return {
    async start() {
      if (!musicEl) return;
      setVol(volume);
      musicEl.loop = loop;
      musicEl.currentTime = 0;
      await musicEl.play().catch(() => {});
    },
    duck(on) {
      setVol(on ? volume * 0.2 : volume);
    },
    fadeOut(sec) {
      if (!musicEl) return;
      const from = musicEl.volume;
      const t0 = performance.now();
      clearInterval(fade);
      fade = setInterval(() => {
        const p = (performance.now() - t0) / (sec * 1000);
        setVol(from * (1 - p));
        if (p >= 1) clearInterval(fade);
      }, 50);
    },
    pause() {
      held = !!musicEl && !musicEl.paused && !musicEl.ended;
      musicEl?.pause();
    },
    resume() {
      if (held) musicEl.play().catch(() => {});
      held = false;
    },
    stop() {
      clearInterval(fade);
      musicEl?.pause();
    },
  };
}

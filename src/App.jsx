import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseGpx } from './lib/gpx';
import { disposeMedia, kindOf, loadMedia, readIntoMemory } from './lib/media';
import { buildBasemap, MAP_STYLES } from './lib/map';
import { buildSegments, placeMedia, totalDuration } from './lib/timeline';
import { buildStats, createScene, defaultSubtitle, drawSegment, runReel } from './lib/renderer';
import { createMusicController, getRecordingAudioTrack, routeVideo, unlockMedia } from './lib/audio';
import { pickMimeType, startRecording } from './lib/recorder';
import { clearRecordings, latestRecording, loadRecordingBlob } from './lib/recordingStore';
import { fmtBytes, fmtDateTime, fmtDuration, fmtKm } from './lib/format';
import { composeMusic, MUSIC_STYLES } from './lib/musicgen';

const RESOLUTIONS = {
  '1080x1920': 'Vertical 1080×1920 (Reels / Shorts)',
  '1920x1080': 'Landscape 1080p (16:9)',
  '1280x720': 'Landscape 720p (16:9)',
  '1080x1080': 'Square 1080×1080',
};

const IS_TOUCH = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

const DEFAULTS = {
  title: '',
  resolution: IS_TOUCH ? '1080x1920' : '1920x1080',
  fps: 30,
  mapStyle: 'topo',
  photoSeconds: 3.5,
  maxClip: 8,
  clipStart: 0,
  routeSeconds: 20,
  clockOffset: 0,
  videoAudio: true,
  videoVolume: 1,
  musicVolume: 0.6,
  insetMap: true,
  accent: '#ff6b35',
  bitrate: IS_TOUCH ? 8 : 12,
};

/** Keep the screen on while rendering — iOS suspends the page when it locks. */
async function requestWakeLock() {
  try {
    return await navigator.wakeLock?.request('screen');
  } catch {
    return null;
  }
}

export default function App() {
  const [track, setTrack] = useState(null);
  const [gpxName, setGpxName] = useState('');
  const [items, setItems] = useState([]);
  const [music, setMusic] = useState(null); // the user's own song
  // Background music: 'generated' (composed on the device), 'file' (user's song) or 'none'.
  const [musicMode, setMusicMode] = useState('generated');
  const [musicStyle, setMusicStyle] = useState('sunnyTrail');
  const [musicSeed, setMusicSeed] = useState(() => Math.floor(Math.random() * 1e9));
  const [genMusic, setGenMusic] = useState(null); // { key, url }
  const [genBusy, setGenBusy] = useState(false);
  // One persistent element for generated music, so iOS's tap-to-unlock carries over when
  // the tune is re-composed (only its src changes).
  const [genEl] = useState(() => {
    const el = new Audio();
    el.preload = 'auto';
    return el;
  });
  const genJob = useRef(null);
  const [settings, setSettings] = useState(DEFAULTS);
  const [busy, setBusy] = useState(null);
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [output, setOutput] = useState(null);
  const [errors, setErrors] = useState([]);
  const [dragging, setDragging] = useState(false);

  const canvasRef = useRef(null);
  const abortRef = useRef(null);
  const basemapRef = useRef({ key: null, promise: null });
  const gpxInput = useRef(null);
  const mediaInput = useRef(null);
  const musicInput = useRef(null);

  const [W, H] = settings.resolution.split('x').map(Number);
  const set = (k) => (e) => {
    const t = e.target.type;
    const v = t === 'checkbox' ? e.target.checked : t === 'number' || t === 'range' ? Number(e.target.value) : e.target.value;
    setSettings((s) => ({ ...s, [k]: v }));
  };

  const placed = useMemo(() => placeMedia(items, track, settings.clockOffset), [items, track, settings.clockOffset]);
  const segments = useMemo(() => buildSegments(placed, track, settings), [placed, track, settings]);
  const estSeconds = totalDuration(segments);

  // Generated music is composed for the video's length (+2 s so it never runs short).
  const musicSeconds = Math.ceil(estSeconds + 2);
  const musicKey = `${musicStyle}|${musicSeed}|${musicSeconds}`;
  const ensureMusic = useCallback(
    (key, style, seed, seconds) => {
      if (genJob.current?.key === key) return genJob.current.promise;
      setGenBusy(true);
      const promise = composeMusic({ style, seed, seconds })
        .then(({ blob }) => {
          if (genJob.current?.key !== key) return; // superseded by a newer request
          const url = URL.createObjectURL(blob);
          genEl.src = url;
          setGenMusic((old) => {
            if (old) URL.revokeObjectURL(old.url);
            return { key, url };
          });
        })
        .catch((e) => {
          setErrors((errs) => [...errs, `Music: ${e.message}`]);
          genJob.current = null;
        })
        .finally(() => {
          if (genJob.current?.key === key || !genJob.current) setGenBusy(false);
        });
      genJob.current = { key, promise };
      return promise;
    },
    [genEl]
  );
  const hasContent = !!track || items.length > 0;
  useEffect(() => {
    if (musicMode !== 'generated' || !hasContent) return;
    const id = setTimeout(() => ensureMusic(musicKey, musicStyle, musicSeed, musicSeconds), 600);
    return () => clearTimeout(id);
  }, [musicMode, hasContent, musicKey, musicStyle, musicSeed, musicSeconds, ensureMusic]);
  const musicReady = musicMode !== 'generated' || (genMusic?.key === musicKey && !genBusy);
  const activeMusicEl = musicMode === 'file' ? music?.el : musicMode === 'generated' && genMusic ? genEl : null;

  /* ───────────── file intake ───────────── */

  const addFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList);
    const errs = [];
    let done = 0;
    for (const picked of files) {
      const kind = kindOf(picked);
      setBusy({ label: `Processing ${picked.name}`, done, total: files.length });
      try {
        const file = kind ? await readIntoMemory(picked) : picked;
        if (kind === 'gpx') {
          setTrack(parseGpx(await file.text()));
          setGpxName(file.name);
        } else if (kind === 'audio') {
          setMusic((old) => {
            if (old) URL.revokeObjectURL(old.url);
            const url = URL.createObjectURL(file);
            const el = new Audio(url);
            el.preload = 'auto';
            return { name: file.name, url, el };
          });
          setMusicMode('file');
        } else if (kind) {
          const item = await loadMedia(file);
          setItems((prev) => [...prev, item]);
        } else {
          errs.push(`${picked.name}: unsupported file type`);
        }
      } catch (e) {
        errs.push(`${picked.name}: ${e.message}`);
      }
      done++;
    }
    setBusy(null);
    setErrors(errs);
  }, []);

  const pick = (ref) => () => ref.current?.click();
  // Don't clear input.value (iOS can invalidate the picked files); remount the inputs
  // afterwards instead, so the same file can be picked again.
  const [inputKey, setInputKey] = useState(0);
  const onPicked = (e) => {
    addFiles([...e.target.files]).finally(() => setInputKey((k) => k + 1));
  };

  const removeItem = (id) =>
    setItems((prev) => {
      const it = prev.find((i) => i.id === id);
      if (it) disposeMedia(it);
      return prev.filter((i) => i.id !== id);
    });

  const removeMusic = () => {
    music.el.pause();
    URL.revokeObjectURL(music.url);
    setMusic(null);
  };

  const clearAll = () => {
    items.forEach(disposeMedia);
    setItems([]);
    setTrack(null);
    setGpxName('');
    if (music) removeMusic();
    if (output) URL.revokeObjectURL(output.url);
    setOutput(null);
    setErrors([]);
  };

  /* ───────────── scene preparation ───────────── */

  const prepare = useCallback(async () => {
    let basemap = null;
    if (track) {
      const key = `${gpxName}|${track.totalDist}|${W}x${H}|${settings.mapStyle}`;
      // Share one in-flight build between the poster frame and Preview/Generate.
      if (basemapRef.current.key !== key) {
        setBusy({ label: 'Loading map tiles…', done: 0, total: 1 });
        const promise = buildBasemap(track, W, H, settings.mapStyle, (p) =>
          setBusy({ label: 'Loading map tiles…', done: p, total: 1 })
        )
          .then(
            (bm) => {
              if (bm.failed)
                setErrors((e) => [...e, `${bm.failed} of ${bm.total} map tiles failed to load (check your connection or try another map style).`]);
              return bm;
            },
            (err) => {
              basemapRef.current = { key: null, promise: null };
              throw err;
            }
          )
          .finally(() => setBusy(null));
        basemapRef.current = { key, promise };
      }
      basemap = await basemapRef.current.promise;
    }
    return createScene({
      W,
      H,
      track,
      basemap,
      placed,
      settings,
      title: settings.title.trim() || track?.name || 'My Hike',
      subtitle: defaultSubtitle(track, items),
      stats: buildStats(track, items),
    });
  }, [track, gpxName, W, H, settings, placed, items]);

  // Poster frame whenever inputs change.
  useEffect(() => {
    if (status !== 'idle') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const scene = await prepare();
        if (cancelled) return;
        const intro = segments[0];
        drawSegment(canvas.getContext('2d'), scene, intro, intro.duration * 0.45, 0);
      } catch (e) {
        setErrors((errs) => [...errs, e.message]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [prepare, segments, status, W, H]);

  /* ───────────── play / record ───────────── */

  // Must stay synchronous up to unlockMedia(): iOS only unlocks audio inside the tap itself.
  function start(record) {
    const unlocked = unlockMedia(
      items.filter((i) => i.video).map((i) => i.video),
      activeMusicEl
    );
    run(record, unlocked);
  }

  async function run(record, unlocked) {
    setErrors([]);
    if (record && output) {
      URL.revokeObjectURL(output.url);
      setOutput(null);
    }
    const canvas = canvasRef.current;
    await unlocked;
    const scene = await prepare();
    for (const it of items) if (it.video) routeVideo(it.video, settings.videoAudio ? settings.videoVolume : 0);
    const musicCtl = createMusicController(activeMusicEl, activeMusicEl ? settings.musicVolume : 0, {
      loop: musicMode === 'file', // generated music is already composed to the right length
    });

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStatus(record ? 'recording' : 'playing');
    setProgress(0);
    let wakeLock = await requestWakeLock();
    const relock = async () => {
      if (document.visibilityState === 'visible' && !ctrl.signal.aborted) wakeLock = await requestWakeLock();
    };
    document.addEventListener('visibilitychange', relock);

    let recorder = null;
    try {
      if (record) {
        recorder = await startRecording(canvas, getRecordingAudioTrack(), {
          fps: settings.fps,
          videoBitsPerSecond: settings.bitrate * 1_000_000,
          name: fileBase(scene.title),
        });
      }
      let last = 0;
      await runReel(canvas, scene, segments, {
        signal: ctrl.signal,
        music: musicCtl,
        videoAudio: settings.videoAudio,
        onProgress: (p) => {
          const now = performance.now();
          if (now - last > 100 || p >= 1) {
            last = now;
            setProgress(p);
          }
        },
      });
    } catch (e) {
      setErrors([e.message]);
    } finally {
      musicCtl.stop();
      document.removeEventListener('visibilitychange', relock);
      wakeLock?.release?.().catch(() => {});
      if (recorder) {
        const blob = await recorder.stop();
        if (!ctrl.signal.aborted) {
          setOutput(makeOutput(blob, `${fileBase(scene.title)}.${recorder.ext}`));
        } else {
          clearRecordings().catch(() => {});
        }
      }
      abortRef.current = null;
      setStatus('idle');
    }
  }

  const stop = () => abortRef.current?.abort();

  // If the page was reloaded (iOS does this when a tab runs low on memory), bring back the
  // last video: it was saved to on-device storage while recording.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rec = await latestRecording();
        if (!rec || cancelled) return;
        const blob = await loadRecordingBlob(rec);
        if (!blob || cancelled) return;
        setOutput((cur) => cur || { ...makeOutput(blob, rec.name), recovered: true, partial: rec.status !== 'done' });
      } catch {
        /* storage unavailable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const discardOutput = () => {
    URL.revokeObjectURL(output.url);
    setOutput(null);
    clearRecordings().catch(() => {});
  };

  // On a phone the result card sits below the preview; bring it into view when it's ready.
  const outputRef = useRef(null);
  useEffect(() => {
    if (output) outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [output]);

  // On iPhone the share sheet is the way to "Save Video" into Photos.
  const canShare = output && navigator.canShare?.({ files: [output.file] });
  const share = async () => {
    try {
      await navigator.share({ files: [output.file], title: output.name });
    } catch (e) {
      if (e.name !== 'AbortError') setErrors([`Sharing failed: ${e.message}`]);
    }
  };

  /* ───────────── render ───────────── */

  const running = status !== 'idle';
  const mime = useMemo(pickMimeType, []);
  const ready = (track || items.length) && !busy && musicReady;
  const photos = items.filter((i) => i.kind === 'photo').length;
  const videos = items.length - photos;
  const durationLabel = `${Math.floor(estSeconds / 60)}:${String(Math.round(estSeconds % 60)).padStart(2, '0')}`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="logo" src="icon.svg" alt="" />
          <div>
            <h1>Trail Reel</h1>
            <p>GPX + photos + videos → a finished hiking video</p>
          </div>
        </div>
        {(track || items.length > 0) && (
          <button className="ghost" onClick={clearAll} disabled={running}>
            Start over
          </button>
        )}
      </header>

      <input key={`gpx${inputKey}`} ref={gpxInput} type="file" hidden onChange={onPicked} />
      <input key={`media${inputKey}`} ref={mediaInput} type="file" hidden multiple accept="image/*,video/*,.heic,.heif,.mov" onChange={onPicked} />
      <input key={`music${inputKey}`} ref={musicInput} type="file" hidden accept="audio/*,.mp3,.m4a" onChange={onPicked} />

      <main className="layout">
        <aside className="sidebar">
          <section
            className={`s-add card dropzone ${dragging ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            <div className="add-buttons">
              <button className={`add ${track ? 'done' : ''}`} onClick={pick(gpxInput)} disabled={running}>
                <span className="add-icon">⛰</span>
                <span className="add-text">
                  <strong>{track ? 'GPX loaded' : 'Add GPX track'}</strong>
                  <small>{track ? `${fmtKm(track.totalDist, 1)} · tap to replace` : 'From Files, Strava, Garmin…'}</small>
                </span>
              </button>
              <button className={`add ${items.length ? 'done' : ''}`} onClick={pick(mediaInput)} disabled={running}>
                <span className="add-icon">🖼</span>
                <span className="add-text">
                  <strong>Add photos &amp; videos</strong>
                  <small>{items.length ? `${photos} photos · ${videos} videos` : 'HEIC, JPG, MOV, MP4'}</small>
                </span>
              </button>
            </div>
            <p className="drop-hint">…or drop files anywhere in this box</p>
          </section>

          {busy && (
            <div className="s-busy busy">
              <div className="spinner" />
              <div>
                <div className="busy-label">{busy.label}</div>
                <div className="bar small">
                  <div style={{ width: `${(busy.done / busy.total) * 100}%` }} />
                </div>
              </div>
            </div>
          )}

          {errors.length > 0 && (
            <div className="s-errors errors">
              {errors.map((e, i) => (
                <div key={i}>⚠ {e}</div>
              ))}
            </div>
          )}

          {track && (
            <section className="s-sources card">
              <h2>Sources</h2>
              <div className="source-row">
                <span className="tag gpx">GPX</span>
                <div className="source-info">
                  <strong>{track.name || gpxName}</strong>
                  <span>
                    {fmtKm(track.totalDist, 1)}
                    {track.hasEle && ` · ▲ ${Math.round(track.gain)} m`}
                    {track.hasTime && ` · ${fmtDuration(track.duration)}`}
                    {` · ${track.points.length.toLocaleString()} pts`}
                  </span>
                </div>
              </div>
            </section>
          )}

          <section className="s-music card music">
            <h2>Music</h2>
            <div className="segmented" role="radiogroup" aria-label="Background music">
              {[
                ['generated', '✨ Generated'],
                ['file', '♪ My song'],
                ['none', 'No music'],
              ].map(([mode, label]) => (
                <button
                  key={mode}
                  role="radio"
                  aria-checked={musicMode === mode}
                  className={musicMode === mode ? 'on' : ''}
                  onClick={() => setMusicMode(mode)}
                  disabled={running}
                >
                  {label}
                </button>
              ))}
            </div>

            {musicMode === 'generated' && (
              <>
                <div className="style-grid">
                  {Object.entries(MUSIC_STYLES).map(([k, st]) => (
                    <button
                      key={k}
                      className={`style-chip ${musicStyle === k ? 'on' : ''}`}
                      aria-pressed={musicStyle === k}
                      onClick={() => setMusicStyle(k)}
                      disabled={running}
                    >
                      <span className="chip-icon">{st.icon}</span>
                      <span className="chip-text">
                        <strong>{st.label}</strong>
                        <small>{st.desc}</small>
                      </span>
                    </button>
                  ))}
                </div>
                <div className="gen-row">
                  <button onClick={() => setMusicSeed(Math.floor(Math.random() * 1e9))} disabled={running || genBusy}>
                    🎲 New tune
                  </button>
                  {genBusy ? (
                    <span className="composing">
                      <span className="spinner small" /> Composing…
                    </span>
                  ) : genMusic ? (
                    <audio className="music-preview" controls preload="none" src={genMusic.url} />
                  ) : (
                    <span className="muted">{hasContent ? '' : 'Add your hike first — the tune is made to fit the video.'}</span>
                  )}
                </div>
                <small className="muted">Composed on your device to fit this video · royalty-free</small>
              </>
            )}

            {musicMode === 'file' &&
              (music ? (
                <div className="source-row">
                  <span className="tag music">SONG</span>
                  <div className="source-info grow">
                    <strong>{music.name}</strong>
                  </div>
                  <button className="icon" title="Remove song" onClick={removeMusic} disabled={running}>
                    ✕
                  </button>
                </div>
              ) : (
                <button className="choose-song" onClick={pick(musicInput)} disabled={running}>
                  Choose a song (MP3, M4A)…
                </button>
              ))}
          </section>

          <details className="s-settings card settings" open={!IS_TOUCH}>
            <summary>
              <h2>Video settings</h2>
            </summary>
            <div className="settings-body">
              <label>
                Title
                <input type="text" placeholder={track?.name || 'My Hike'} value={settings.title} onChange={set('title')} />
              </label>
              <div className="row2">
                <label>
                  Format
                  <select value={settings.resolution} onChange={set('resolution')}>
                    {Object.entries(RESOLUTIONS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Map style
                  <select value={settings.mapStyle} onChange={set('mapStyle')}>
                    {Object.entries(MAP_STYLES).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Range label="Photo duration" unit="s" min={1.5} max={8} step={0.5} value={settings.photoSeconds} onChange={set('photoSeconds')} />
              <Range label="Max video clip" unit="s" min={2} max={30} step={1} value={settings.maxClip} onChange={set('maxClip')} />
              <Range label="Skip start of clips" unit="s" min={0} max={10} step={0.5} value={settings.clipStart} onChange={set('clipStart')} />
              <Range label="Route animation (total)" unit="s" min={5} max={60} step={1} value={settings.routeSeconds} onChange={set('routeSeconds')} />
              <Range
                label="Camera clock offset"
                unit=" min"
                min={-720}
                max={720}
                step={5}
                value={settings.clockOffset}
                onChange={set('clockOffset')}
                hint="Shift media timestamps if your camera's clock or time zone differs from the GPS."
              />
              <div className="row2">
                <label className="check">
                  <input type="checkbox" checked={settings.videoAudio} onChange={set('videoAudio')} /> Video sound
                </label>
                <label className="check">
                  <input type="checkbox" checked={settings.insetMap} onChange={set('insetMap')} /> Mini-map
                </label>
              </div>
              {musicMode !== 'none' && (
                <Range label="Music volume" unit="" min={0} max={1} step={0.05} value={settings.musicVolume} onChange={set('musicVolume')} />
              )}
              <div className="row2">
                <label>
                  Accent color
                  <input type="color" value={settings.accent} onChange={set('accent')} />
                </label>
                <label>
                  Quality
                  <select value={settings.bitrate} onChange={set('bitrate')}>
                    <option value={6}>Small (6 Mbps)</option>
                    <option value={8}>Good (8 Mbps)</option>
                    <option value={12}>High (12 Mbps)</option>
                    <option value={20}>Max (20 Mbps)</option>
                  </select>
                </label>
              </div>
            </div>
          </details>
        </aside>

        <section className="stage">
          <div className="s-preview preview-wrap">
            <canvas ref={canvasRef} width={W} height={H} className="preview" style={{ aspectRatio: `${W} / ${H}` }} />
            {!track && !items.length && (
              <div className="empty-overlay">
                <p>Add a GPX track and some photos or videos to get started.</p>
              </div>
            )}
          </div>

          <div className="s-actions controls">
            {running ? (
              <>
                <button className="danger" onClick={stop}>
                  ■ Stop
                </button>
                <div className="progress">
                  <div className="bar">
                    <div style={{ width: `${progress * 100}%` }} />
                  </div>
                  <span>
                    {status === 'recording' ? '● Recording' : 'Previewing'} · {Math.round(progress * 100)}% · keep the app open
                  </span>
                </div>
              </>
            ) : (
              <>
                <button className="secondary" disabled={!ready} onClick={() => start(false)}>
                  ▶ Preview
                </button>
                <button className="primary" disabled={!ready || !mime} onClick={() => start(true)}>
                  ● Create video
                </button>
                <span className="muted est">
                  {genBusy && musicMode === 'generated' ? '♪ Composing music… · ' : ''}≈ {durationLabel} · {segments.length} scenes · {mime ? mime.split(';')[0].replace('video/', '').toUpperCase() : 'recording unsupported'}
                </span>
              </>
            )}
          </div>

          {output && (
            <div ref={outputRef} className="s-output output card">
              <video src={output.url} controls playsInline preload="metadata" className="result" />
              <div className="output-info">
                <strong>{output.recovered ? 'Your last video (restored)' : 'Your video is ready'}</strong>
                {output.partial && <span className="muted">The page was reloaded while recording, so this video may be cut short.</span>}
                <span className="muted">
                  {output.name} · {fmtBytes(output.size)}
                </span>
                <div className="output-buttons">
                  {canShare && (
                    <button className="primary" onClick={share}>
                      Save / Share
                    </button>
                  )}
                  <a className={`${canShare ? 'secondary' : 'primary'} button`} href={output.url} download={output.name}>
                    Download
                  </a>
                  <button className="ghost" onClick={discardOutput}>
                    Discard
                  </button>
                </div>
              </div>
            </div>
          )}

          {placed.length > 0 && (
            <section className="s-story card">
              <h2>
                Storyboard <span className="muted">— ordered along the trail</span>
              </h2>
              <div className="grid">
                {placed.map(({ item, dist, via, t }) => (
                  <figure key={item.id} className="media-card">
                    <div className="thumb" style={{ backgroundImage: `url(${item.thumb})` }}>
                      <span className={`badge ${item.kind}`}>{item.kind === 'video' ? `▶ ${Math.round(item.duration)}s` : 'PHOTO'}</span>
                      <button className="remove" onClick={() => removeItem(item.id)} disabled={running} aria-label={`Remove ${item.name}`}>
                        ✕
                      </button>
                    </div>
                    <figcaption>
                      <div className="name" title={item.name}>
                        {item.name}
                      </div>
                      <div className="meta">
                        {t ? fmtDateTime(t) : '—'}
                        {track && dist != null && (
                          <>
                            {' '}
                            · {fmtKm(dist, 1)}{' '}
                            <span className={`via ${via}`} title={viaHint[via]}>
                              {via}
                            </span>
                          </>
                        )}
                      </div>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          )}
        </section>
      </main>
    </div>
  );
}

const fileBase = (title) => (title || 'hike').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'hike';

function makeOutput(blob, name) {
  return { url: URL.createObjectURL(blob), name, size: blob.size, file: new File([blob], name, { type: blob.type }) };
}

const viaHint = {
  time: 'Placed by matching the timestamp to the GPX track',
  gps: 'Placed by the GPS location stored in the file',
  order: 'No time/GPS match — placed by capture order',
};

function Range({ label, unit, hint, ...props }) {
  return (
    <label className="range">
      <span className="range-head">
        {label}
        <b>
          {props.value}
          {unit}
        </b>
      </span>
      <input type="range" {...props} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

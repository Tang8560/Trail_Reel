# Trail Reel

Turn a hike's **GPX track + HEIC/JPG photos + videos** into a finished video. Everything runs in your browser; your files are never uploaded.

## Run

```bash
npm install
npm run dev      # opens http://localhost:5173
npm run build    # static build in dist/
```

Use a recent **Chrome, Edge or Safari**. All three record MP4 directly; other browsers fall back to WebM.

## Use it on an iPhone

Trail Reel is a Progressive Web App (PWA). It installs from Safari to the Home Screen and runs full-screen like an app, with no App Store or Mac needed. iPhone needs **iOS 16.4 or later**.

**Option A: host it (recommended).** Upload the contents of `dist/` after `npm run build` to any HTTPS static host, such as GitHub Pages, Netlify, Vercel, Cloudflare Pages or your own server. On the iPhone, open the URL in **Safari**, then tap **Share → Add to Home Screen**.

**Option B: test from this PC over Wi-Fi.**
```bash
npm run dev:phone
```
This serves the app over HTTPS on your local network. Open the `Network: https://192.168.x.x:5173` URL it prints in Safari on an iPhone on the same Wi-Fi. Safari warns about the self-signed certificate; tap *Show Details → visit this website*. The app works fully this way, but iOS won't install the offline service worker on a self-signed certificate. Use option A for a real install. Windows Firewall may ask you to allow Node.js on private networks.

**On the phone:**
- **Add GPX track** opens the Files app (export the GPX from Strava, Garmin, AllTrails… into Files first).
- **Add photos & videos** opens your photo library. Choosing *Options → Include location* in the picker helps place photos that aren't time-matched.
- **Create video** records the reel in real time. The app keeps the screen awake, but don't switch apps until it finishes.
- **Save / Share** opens the iOS share sheet; choose **Save Video** to put it in Photos.

## How it works

1. **Drop files**: one `.gpx`, any number of photos (`.heic`, `.jpg`, `.png`) and videos (`.mp4`, `.mov`, `.webm`), plus an optional music track (`.mp3`, `.m4a`).
2. **Auto placement**: each photo or video is matched to a point on the trail:
   - `TIME`: its EXIF or video creation time falls within the GPX time range (best)
   - `GPS`: it has an embedded location within 750 m of the track
   - `ORDER`: neither matched, so it's placed by capture order
   If everything looks shifted, use **Camera clock offset** (for a wrong camera clock or time zone).
3. **Generated video**:
   - Intro: title, date and stats over the map
   - Animated route drawing with a live distance/elevation/time HUD and elevation profile
   - At each photo or clip: a Ken Burns photo or the video clip (with sound), a mini-map and a caption
   - Outro with a summary of distance, elevation gain, highest point and time
   - Background music lowers its volume under video sound and fades out at the end
4. **Music**: choose one of three options in the Music card:
   - **✨ Generated** (default): an original, royalty-free tune composed on your device to fit the video's exact length. Choose a style: *Sunny Trail* (ukulele and whistling), *Meadow Stroll* (bouncy folk with handclaps), *Summit Morning* (builds to an uplifting finish) or *Golden Hour* (warm fingerpicked guitar). All styles are major-key and upbeat. **🎲 New tune** composes a different song in the same style. The music is rule-based composition (chords, melody, bass and percussion from music-theory rules and a random seed), not an online AI service, so it's free, works offline and nothing is uploaded.
   - **♪ My song**: use your own MP3/M4A.
   - **No music**.
5. **Preview** plays it live; **Create video** records it and gives you a download.

## Notes

- iPhone memory: photos are stored as compact JPEGs and decoded only while on screen, so long hikes with many photos don't crash Safari. Videos over 300 MB are read from the file directly instead of being copied into memory.
- The iOS photo picker may convert HEVC videos to H.264, and converted clips can lose their original capture time. Those clips fall back to the file date; use the clock offset, or the clip lands by capture order.
- Recording happens in real time (a 2-minute video takes about 2 minutes). Keep the tab visible while it records.
- HEIC is decoded natively on Safari; on other browsers `heic-to` is loaded on demand (slower).
- iPhone `.mov` files are HEVC. Chrome/Edge on Windows play them only if HEVC hardware decoding is available. If a clip is rejected, export it as H.264 first.
- Map tiles: OpenTopoMap, Esri World Imagery and OpenStreetMap. Credits are drawn on the video. Tiles are fetched once per render; please respect each provider's usage policy.

## Code map

| File | Purpose |
| --- | --- |
| `src/lib/gpx.js` | GPX parsing, distance/elevation gain, time/location → trail position |
| `src/lib/media.js` | HEIC/JPG decoding, EXIF, video loading, thumbnails |
| `src/lib/mp4meta.js` | Reads creation time + GPS from MP4/MOV `moov` box |
| `src/lib/map.js` | Fetches map tiles into a basemap framing the route |
| `src/lib/timeline.js` | Places media on the trail and builds the scene list |
| `src/lib/renderer.js` | Draws every frame on canvas, runs playback |
| `src/lib/audio.js` | Web Audio mixing (video sound, music, ducking) |
| `src/lib/recorder.js` | `MediaRecorder` capture to MP4/WebM (saved to IndexedDB while recording) |
| `src/lib/recordingStore.js` | Keeps the last video on the device so it survives a page reload |
| `src/lib/musicgen.js` | On-device music generator (styles, melody/chords, sampler, WAV output) |
| `vite.config.js` | PWA manifest + service worker (offline app shell, cached map tiles) |

import { appendChunk, beginRecording, finishRecording, loadRecordingBlob } from './recordingStore';

const CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  return CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

export const extFor = (mimeType) => (mimeType.startsWith('video/mp4') ? 'mp4' : 'webm');

/**
 * Record the canvas (+ audio). Each second of video is written to IndexedDB as it arrives,
 * so the result survives the tab being reloaded and isn't held in memory. Falls back to
 * memory if storage is unavailable (e.g. private browsing or quota exhausted).
 */
export async function startRecording(canvas, audioTrack, { fps = 30, videoBitsPerSecond = 10_000_000, name = 'hike' } = {}) {
  const mimeType = pickMimeType();
  if (!mimeType) throw new Error('MediaRecorder is not supported in this browser');
  const type = mimeType.split(';')[0];
  const ext = extFor(mimeType);

  let stored = null;
  try {
    stored = await beginRecording({ name: `${name}.${ext}`, type });
  } catch {
    stored = null;
  }
  const memChunks = [];
  let writes = Promise.resolve();

  const stream = new MediaStream([
    ...canvas.captureStream(fps).getVideoTracks(),
    ...(audioTrack ? [audioTrack] : []),
  ]);
  const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond, audioBitsPerSecond: 192_000 });
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    if (!stored) {
      memChunks.push(e.data);
      return;
    }
    // Serialize writes so chunks stay in order.
    writes = writes.then(() =>
      appendChunk(stored, e.data).catch(() => {
        memChunks.push(e.data); // storage failed (quota?) — keep the rest in memory
      })
    );
  };
  rec.start(1000);

  return {
    mimeType,
    ext,
    persisted: !!stored,
    // Paused time is left out of the file, so loading/decoding stalls never show as freezes.
    pause: () => rec.state === 'recording' && rec.pause(),
    resume: () => rec.state === 'paused' && rec.resume(),
    stop: () =>
      new Promise((resolve) => {
        rec.onstop = async () => {
          stream.getVideoTracks().forEach((t) => t.stop());
          await writes;
          const parts = [];
          if (stored) {
            await finishRecording(stored).catch(() => {});
            const saved = await loadRecordingBlob(stored).catch(() => null);
            if (saved) parts.push(saved);
          }
          parts.push(...memChunks);
          resolve(new Blob(parts, { type }));
        };
        rec.stop();
      }),
  };
}

/**
 * Cinewav Audience PWA — Main App v5
 *
 * Architecture changes from v4:
 *
 * PLAYBACK ENGINE: HTMLAudioElement (Blob URL) instead of AudioBufferSourceNode
 * ─────────────────────────────────────────────────────────────────────────────
 * v4 used AudioBufferSourceNode which is a disposable one-shot object:
 *   - Cannot be paused or seeked — every seek creates a new node
 *   - AudioContext gets CLOSED by iOS/Android when nothing is playing + screen off
 *   - A closed AudioContext cannot be resumed; must be recreated + audio re-decoded
 *   - This caused the "stuck after film ends with screen off" bug on both platforms
 *
 * v5 uses a persistent HTMLAudioElement with a Blob URL:
 *   - Lives for the entire session — never closed, never recreated
 *   - Supports .currentTime (seek), .play(), .pause() natively
 *   - iOS/Android treat it like a music player — audio continues through screen lock
 *   - Media Session API integrates naturally (lock screen controls work)
 *   - No AudioContext lifecycle to manage
 *
 * DRIFT MEASUREMENT: performance.now() instead of audioCtx.currentTime
 * ─────────────────────────────────────────────────────────────────────
 * We no longer have an AudioContext, so drift is measured using:
 *   expected = playStartPos + (performance.now() - playStartPerfTime) / 1000
 * performance.now() is a high-resolution monotonic clock, not throttled by
 * the browser for audio use cases. audioEl.currentTime is also available as
 * a direct ground truth for drift measurement.
 *
 * SERVICE WORKER: unchanged — still owns WebSocket + NTP pings.
 */

import { saveAudio, loadAudio } from './audioStorage';

// ── Types ─────────────────────────────────────────────────────────────────────
interface ShowCommand {
  action:    'play' | 'pause' | 'seek' | 'load';
  position:  number;
  serverTs:  number;
  masterTs:  number;
  audioFile: string | null;
  receivedAt: number;
  clockOffsetMs: number;
}

// ── DOM ───────────────────────────────────────────────────────────────────────
const screens = {
  join:     document.getElementById('screen-join')!,
  download: document.getElementById('screen-download')!,
  player:   document.getElementById('screen-player')!,
  error:    document.getElementById('screen-error')!,
};

const joinShowIdInput    = document.getElementById('join-show-id')    as HTMLInputElement;
const joinServerUrlInput = document.getElementById('join-server-url') as HTMLInputElement;
const joinBtn            = document.getElementById('join-btn')         as HTMLButtonElement;
const downloadFilename   = document.getElementById('download-filename')!;
const downloadProgress   = document.getElementById('download-progress') as HTMLElement;
const downloadPercent    = document.getElementById('download-percent')!;
const syncDot            = document.getElementById('sync-dot')!;
const syncStatusText     = document.getElementById('sync-status-text')!;
const albumArt           = document.getElementById('album-art')!;
const trackName          = document.getElementById('track-name')!;
const showIdDisplay      = document.getElementById('show-id-display')!;
const seekFill           = document.getElementById('seek-fill')        as HTMLElement;
const pCurrentTime       = document.getElementById('p-current-time')!;
const pTotalTime         = document.getElementById('p-total-time')!;
const statOffset         = document.getElementById('stat-offset')!;
const statDrift          = document.getElementById('stat-drift')!;
const statResyncs        = document.getElementById('stat-resyncs')!;
const statRtt            = document.getElementById('stat-rtt')!;
const waitingOverlay     = document.getElementById('waiting-overlay')!;
const errorMsg           = document.getElementById('error-msg')!;
const syncControlsEl     = document.getElementById('sync-controls')!;
const playPauseBtn       = document.getElementById('play-pause-btn')   as HTMLButtonElement;
const resyncBtn          = document.getElementById('resync-btn')       as HTMLButtonElement;
const ftMinus            = document.getElementById('ft-minus')         as HTMLButtonElement;
const ftPlus             = document.getElementById('ft-plus')          as HTMLButtonElement;
const ftReset            = document.getElementById('ft-reset')         as HTMLButtonElement;
const ftValue            = document.getElementById('ft-value')!;

// ── App State ─────────────────────────────────────────────────────────────────

// The persistent audio element — created once, lives for the session.
// Using a Blob URL so it behaves like a real audio file to the OS.
let audioEl:       HTMLAudioElement | null = null;
let audioBlobUrl:  string | null           = null;
let audioDuration  = 0;
let isPlaying      = false;

// Playback tracking for drift calculation
let playStartPos      = 0;   // audioEl.currentTime when we last called play()
let playStartWallMs   = 0;   // performance.now() when we last called play()

let uiInterval:    ReturnType<typeof setInterval> | null = null;
let driftInterval: ReturnType<typeof setInterval> | null = null;

let showId        = '';
let serverBaseUrl = '';
let manualOffsetMs = 0;

// Clock state (updated from Service Worker)
let clockOffsetMs = 0;
let rttMs         = 0;
let resyncs       = 0;
let driftMs       = 0;

// Master state (last known from Service Worker)
let masterIsPlaying  = false;
let masterPosition   = 0;
let masterPositionAt = 0;   // Date.now() when masterPosition was last updated

// Pending command received before audio was loaded
let pendingCommand: ShowCommand | null = null;

// Service Worker reference
let syncSW: ServiceWorker | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const h   = Math.floor(s / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`;
}

function showScreen(name: keyof typeof screens) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function showError(msg: string) {
  errorMsg.textContent = msg;
  showScreen('error');
}

type SyncStatusType = 'waiting' | 'syncing' | 'synced' | 'drifted';
function setSyncStatus(status: SyncStatusType, label: string) {
  syncDot.className = `status-dot ${
    status === 'synced'  ? 'synced'  :
    status === 'drifted' ? 'drifted' :
    status === 'syncing' ? 'syncing' : ''
  }`;
  syncStatusText.textContent = label;
}

function loadManualOffset() {
  const saved = localStorage.getItem(`cinewav_offset_${showId}`);
  manualOffsetMs = saved ? parseInt(saved, 10) : 0;
  renderOffsetDisplay();
}

function saveManualOffset() {
  localStorage.setItem(`cinewav_offset_${showId}`, String(manualOffsetMs));
  renderOffsetDisplay();
}

function renderOffsetDisplay() {
  ftValue.textContent = (manualOffsetMs >= 0 ? '+' : '') + manualOffsetMs + 'ms';
  ftValue.style.color =
    manualOffsetMs === 0 ? 'var(--text-muted)' :
    manualOffsetMs > 0   ? 'var(--warning)'    : 'var(--success)';
}

function parseUrlParams() {
  const p      = new URLSearchParams(window.location.search);
  const show   = p.get('show');
  const server = p.get('server');
  if (show)   joinShowIdInput.value    = show;
  if (server) joinServerUrlInput.value = decodeURIComponent(server);
}

function sendToSW(msg: object) {
  if (syncSW) {
    syncSW.postMessage(msg);
  } else if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(msg);
  }
}

// ── Audio Download ────────────────────────────────────────────────────────────
async function downloadAudioFile(url: string, filename: string): Promise<ArrayBuffer> {
  showScreen('download');
  downloadFilename.textContent = filename;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const total  = parseInt(response.headers.get('Content-Length') || '0', 10);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) {
      const pct = Math.round((received / total) * 100);
      downloadProgress.style.width = `${pct}%`;
      downloadPercent.textContent  = `${pct}% — ${(received/1024/1024).toFixed(1)} MB`;
    } else {
      downloadPercent.textContent = `${(received/1024/1024).toFixed(1)} MB downloaded…`;
    }
  }

  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf.buffer;
}

// ── Audio Engine (HTMLAudioElement) ──────────────────────────────────────────

/**
 * Initialize the persistent audio element from an ArrayBuffer.
 * Creates a Blob URL so the OS treats it as a real audio file.
 * Called once when audio is first loaded; subsequent seeks use audioEl.currentTime.
 */
async function initAudio(arrayBuffer: ArrayBuffer): Promise<void> {
  // Revoke old Blob URL if any
  if (audioBlobUrl) {
    URL.revokeObjectURL(audioBlobUrl);
    audioBlobUrl = null;
  }

  // Detect MIME type from first 4 bytes (mp3 = ID3 or 0xFF 0xFB, mp4/m4a = ftyp)
  const header = new Uint8Array(arrayBuffer, 0, 12);
  let mimeType = 'audio/mpeg'; // default
  if (header[0] === 0x66 && header[1] === 0x74 && header[2] === 0x79 && header[3] === 0x70) {
    mimeType = 'audio/mp4';
  } else if (header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70) {
    mimeType = 'audio/mp4';
  } else if (header[0] === 0x4F && header[1] === 0x67 && header[2] === 0x67 && header[3] === 0x53) {
    mimeType = 'audio/ogg';
  }

  const blob = new Blob([arrayBuffer], { type: mimeType });
  audioBlobUrl = URL.createObjectURL(blob);

  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';

    // When audio ends naturally, update state
    audioEl.addEventListener('ended', () => {
      isPlaying = false;
      albumArt.classList.remove('playing');
      if (uiInterval)    { clearInterval(uiInterval);    uiInterval    = null; }
      if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
      updatePlayPauseBtn();
      if (!masterIsPlaying) {
        setSyncStatus('synced', 'Show ended');
      }
    });

    // When audio is ready to play, update duration display
    audioEl.addEventListener('loadedmetadata', () => {
      audioDuration = audioEl!.duration;
      pTotalTime.textContent = formatTime(audioDuration);
    });
  }

  // Set the new source — this does NOT reset the element, just loads new audio
  audioEl.src = audioBlobUrl;

  // Wait for metadata to load so we have the duration
  await new Promise<void>((resolve) => {
    if (audioEl!.readyState >= 1) {
      audioDuration = audioEl!.duration;
      pTotalTime.textContent = formatTime(audioDuration);
      resolve();
      return;
    }
    audioEl!.addEventListener('loadedmetadata', () => {
      audioDuration = audioEl!.duration;
      pTotalTime.textContent = formatTime(audioDuration);
      resolve();
    }, { once: true });
    audioEl!.addEventListener('error', () => resolve(), { once: true });
  });

  playPauseBtn.disabled = false;
  resyncBtn.disabled    = false;
}

/**
 * Returns the current playback position in seconds.
 * Uses audioEl.currentTime as ground truth when playing.
 */
function getCurrentPosition(): number {
  if (!audioEl || !isPlaying) return playStartPos;
  return audioEl.currentTime;
}

/**
 * Estimate where the master player is RIGHT NOW.
 */
function getEstimatedMasterPosition(): number {
  if (!masterIsPlaying) return masterPosition;
  return masterPosition + (Date.now() - masterPositionAt) / 1000;
}

/**
 * Start playback from rawPosition (seconds, WITHOUT manual offset applied).
 * manualOffsetMs is applied internally.
 *
 * This is the core function — seeks the HTMLAudioElement and calls play().
 * The element is persistent; no new nodes are created.
 */
async function startPlayback(rawPosition: number): Promise<void> {
  if (!audioEl || audioDuration === 0) return;

  if (uiInterval)    { clearInterval(uiInterval);    uiInterval    = null; }
  if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }

  const adjusted = rawPosition + (manualOffsetMs / 1000);
  const clamped  = Math.max(0, Math.min(adjusted, audioDuration - 0.05));

  // Seek to position
  audioEl.currentTime = clamped;
  playStartPos      = clamped;
  playStartWallMs   = performance.now();

  // Play — returns a promise; catch AbortError from rapid seek/play cycles
  try {
    await audioEl.play();
  } catch (err: unknown) {
    // AbortError is expected when seek interrupts a pending play — ignore
    if (err instanceof Error && err.name === 'AbortError') return;
    // NotAllowedError means we need a user gesture — mark as pending
    if (err instanceof Error && err.name === 'NotAllowedError') {
      isPlaying = false;
      updatePlayPauseBtn();
      setSyncStatus('syncing', 'Tap play to start');
      return;
    }
    console.warn('[Audio] play() error:', err);
    return;
  }

  isPlaying = true;
  albumArt.classList.add('playing');
  waitingOverlay.classList.add('hidden');
  updatePlayPauseBtn();
  startUILoop();
  startDriftLoop();
  updateMediaSession();
}

function stopPlayback() {
  if (audioEl) {
    audioEl.pause();
    audioEl.playbackRate = 1.0;  // reset any drift nudge
    playStartPos = audioEl.currentTime;
  }
  if (uiInterval)    { clearInterval(uiInterval);    uiInterval    = null; }
  if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
  isPlaying = false;
  albumArt.classList.remove('playing');
  updatePlayPauseBtn();
}

// ── UI Loop ───────────────────────────────────────────────────────────────────
function startUILoop() {
  if (uiInterval) clearInterval(uiInterval);
  uiInterval = setInterval(() => {
    if (!audioEl || !isPlaying) return;
    const pos     = audioEl.currentTime;
    const clamped = Math.min(pos, audioDuration);
    pCurrentTime.textContent = formatTime(clamped);
    if (audioDuration > 0) seekFill.style.width = `${(clamped / audioDuration) * 100}%`;
    // NOTE: Do NOT call updateMediaSession() here. Calling setPositionState()
    // every 250ms causes iOS to treat each update as a media event, producing
    // audible interruptions. The OS reads position from the HTMLAudioElement
    // directly — no need to push it manually.
  }, 250);
}

// ── Drift Detection Loop ──────────────────────────────────────────────────────
const DRIFT_CHECK_MS      = 500;
// Hard-seek thresholds — only interrupt playback for large drift.
// Small drift is corrected silently via playbackRate nudge (no seek interruption).
const HARD_RESYNC_MS      = 500;   // hard seek if drift exceeds ±500ms
const RATE_NUDGE_MAX_MS   = 499;   // use playbackRate nudge for drift up to 499ms
const RATE_NUDGE_FACTOR   = 0.05;  // max ±5% speed adjustment
function startDriftLoop() {
  if (driftInterval) clearInterval(driftInterval);
  driftInterval = setInterval(() => {
    if (!isPlaying || !masterIsPlaying || !audioEl) return;
    const actualPos   = audioEl.currentTime;
    const expectedPos = getEstimatedMasterPosition() + (manualOffsetMs / 1000);
    driftMs = (actualPos - expectedPos) * 1000;
    statDrift.textContent = `${driftMs >= 0 ? '+' : ''}${Math.round(driftMs)}ms`;
    const abs = Math.abs(driftMs);
    if      (abs < 50)  setSyncStatus('synced',  'In sync');
    else if (abs < 150) setSyncStatus('syncing', `${Math.round(abs)}ms drift`);
    else                setSyncStatus('drifted', `${Math.round(abs)}ms drift`);
    if (abs >= HARD_RESYNC_MS) {
      // Large drift: hard seek (interrupts playback but necessary)
      resyncs++;
      statResyncs.textContent = String(resyncs);
      const targetRaw = getEstimatedMasterPosition();
      audioEl.playbackRate = 1.0;
      startPlayback(targetRaw - (manualOffsetMs / 1000));
      setSyncStatus('synced', 'In sync');
    } else if (abs > 30) {
      // Small/medium drift: nudge playbackRate to converge without seeking.
      // driftMs > 0 means we are AHEAD of master → slow down (rate < 1)
      // driftMs < 0 means we are BEHIND master → speed up (rate > 1)
      const nudge = Math.min(RATE_NUDGE_FACTOR, abs / 1000);
      audioEl.playbackRate = driftMs > 0 ? 1.0 - nudge : 1.0 + nudge;
    } else {
      // Within 30ms — restore normal rate
      audioEl.playbackRate = 1.0;
    }
  }, DRIFT_CHECK_MS);
}

// ── Media Session ─────────────────────────────────────────────────────────────
function setupMediaSession(title: string) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title, artist: 'Cinewav', album: `Show: ${showId}`,
    artwork: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
  // Disable lock screen transport controls — master controls playback
  navigator.mediaSession.setActionHandler('play',  null);
  navigator.mediaSession.setActionHandler('pause', null);
  navigator.mediaSession.setActionHandler('seekto', null);
  navigator.mediaSession.setActionHandler('seekforward', null);
  navigator.mediaSession.setActionHandler('seekbackward', null);
}

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !audioEl) return;
  // Only update playbackState — do NOT call setPositionState() here.
  // setPositionState() triggers OS media events on iOS/Android which cause
  // audible interruptions when called frequently. The OS reads currentTime
  // directly from the HTMLAudioElement.
  navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
}

// ── Play/Pause Button ─────────────────────────────────────────────────────────
function updatePlayPauseBtn() {
  playPauseBtn.innerHTML = isPlaying ? '&#9646;&#9646;' : '&#9654;';
  playPauseBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

playPauseBtn.addEventListener('click', async () => {
  if (!audioEl || audioDuration === 0) return;

  if (isPlaying) {
    stopPlayback();
    setSyncStatus('synced', 'Paused locally');
  } else {
    const rawPos = getEstimatedMasterPosition();
    await startPlayback(rawPos - (manualOffsetMs / 1000));
    setSyncStatus('synced', 'In sync');
  }
});

// ── Show Command Handler ──────────────────────────────────────────────────────
async function handleShowCommand(cmd: ShowCommand) {
  if (!audioEl || audioDuration === 0) {
    pendingCommand = cmd;
    return;
  }

  // Update master state tracking.
  // For 'seek', preserve the current masterIsPlaying value — the master
  // broadcasts 'seek' only when paused; when playing it sends 'play' directly.
  if (cmd.action !== 'seek') {
    masterIsPlaying = (cmd.action === 'play');
  }
  masterPosition   = cmd.position;
  masterPositionAt = cmd.receivedAt;

  setSyncStatus('syncing', 'Syncing…');

  switch (cmd.action) {
    case 'play': {
      await startPlayback(cmd.position - (manualOffsetMs / 1000));
      setSyncStatus('synced', 'In sync');
      if (cmd.audioFile) trackName.textContent = cmd.audioFile;
      break;
    }
    case 'pause': {
      stopPlayback();
      masterIsPlaying  = false;
      masterPosition   = cmd.position;
      masterPositionAt = Date.now();
      // Seek to exact pause position so next play starts from the right spot
      if (audioEl) audioEl.currentTime = Math.max(0, Math.min(cmd.position, audioDuration));
      playStartPos = cmd.position;
      setSyncStatus('synced', 'Paused');
      break;
    }
    case 'seek': {
      const wasPlaying = isPlaying;
      stopPlayback();
      masterPosition   = cmd.position;
      masterPositionAt = Date.now();
      playStartPos     = cmd.position;
      if (audioEl) audioEl.currentTime = Math.max(0, Math.min(cmd.position, audioDuration));
      if (wasPlaying) {
        await startPlayback(cmd.position - (manualOffsetMs / 1000));
        setSyncStatus('synced', 'In sync');
      } else {
        setSyncStatus('synced', 'Paused');
      }
      break;
    }
    case 'load': {
      stopPlayback();
      playStartPos = 0;
      if (audioEl) audioEl.currentTime = 0;
      if (cmd.audioFile) trackName.textContent = cmd.audioFile;
      waitingOverlay.classList.remove('hidden');
      setSyncStatus('waiting', 'Waiting for master');
      break;
    }
  }
}

// ── Manual Resync ─────────────────────────────────────────────────────────────
async function doManualResync() {
  if (!audioEl || audioDuration === 0) return;
  const masterPos = getEstimatedMasterPosition();
  if (masterIsPlaying) {
    await startPlayback(masterPos - (manualOffsetMs / 1000));
    setSyncStatus('synced', 'Resynced');
  } else {
    stopPlayback();
    playStartPos = masterPos;
    if (audioEl) audioEl.currentTime = Math.max(0, Math.min(masterPos, audioDuration));
    setSyncStatus('synced', 'Paused');
  }
}

resyncBtn.addEventListener('click', () => {
  doManualResync().then(() => {
    resyncBtn.textContent = '✓ Synced!';
    setTimeout(() => { resyncBtn.innerHTML = '&#8635; Resync Now'; }, 1500);
  });
});

// ── Fine-Tune Offset Controls ─────────────────────────────────────────────────
function applyOffsetChange(oldOffsetMs: number) {
  if (!audioEl || !isPlaying) return;
  // audioEl.currentTime has old offset baked in — strip it to get raw position
  const rawPos = audioEl.currentTime - (oldOffsetMs / 1000);
  startPlayback(rawPos);
}

ftMinus.addEventListener('click', () => {
  const old = manualOffsetMs;
  manualOffsetMs -= 100;
  saveManualOffset();
  applyOffsetChange(old);
});

ftPlus.addEventListener('click', () => {
  const old = manualOffsetMs;
  manualOffsetMs += 100;
  saveManualOffset();
  applyOffsetChange(old);
});

ftReset.addEventListener('click', () => {
  const old = manualOffsetMs;
  manualOffsetMs = 0;
  saveManualOffset();
  applyOffsetChange(old);
});

// ── Service Worker Message Handler ───────────────────────────────────────────
function handleSWMessage(event: MessageEvent) {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case 'sw_connected':
      setSyncStatus('syncing', 'Syncing clock…');
      break;

    case 'sw_disconnected':
      setSyncStatus('waiting', 'Reconnecting…');
      break;

    case 'sw_clock':
      clockOffsetMs = msg.clockOffsetMs;
      rttMs         = msg.rttMs;
      statOffset.textContent = `${clockOffsetMs >= 0 ? '+' : ''}${Math.round(clockOffsetMs)}ms`;
      statRtt.textContent    = `${Math.round(rttMs)}ms`;
      break;

    case 'sw_rtt':
      rttMs = msg.rttMs;
      statRtt.textContent = `${Math.round(rttMs)}ms`;
      break;

    case 'sw_command': {
      const cmd: ShowCommand = {
        action:       msg.action,
        position:     msg.position,
        serverTs:     msg.serverTs,
        masterTs:     msg.masterTs,
        audioFile:    msg.audioFile,
        receivedAt:   msg.receivedAt,
        clockOffsetMs: msg.clockOffsetMs,
      };
      handleShowCommand(cmd);
      break;
    }

    case 'sw_audience_count':
      break;

    case 'sw_audio_ready':
      handleAudioReady(msg.audioFile, msg.audioHash);
      break;
  }
}

async function handleAudioReady(filename: string, hash: string) {
  const existing = await loadAudio(showId);
  if (existing?.hash === hash) return;
  setSyncStatus('syncing', 'Downloading audio…');
  trackName.textContent = 'Downloading audio…';
  try {
    const buf = await downloadAudioFile(`${serverBaseUrl}/api/show/${showId}/audio`, filename);
    await saveAudio(showId, filename, buf, hash);
    await initAudio(buf);
    trackName.textContent = filename;
    setupMediaSession(filename);
    setSyncStatus('waiting', 'Audio ready — waiting for show');
  } catch {
    setSyncStatus('waiting', 'Download failed — retry');
  }
}

// ── Visibility Change — Hard Resync ──────────────────────────────────────────
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;

  // Tab came back to foreground — request fresh clock sync from Service Worker
  sendToSW({ type: 'sw_hard_resync' });

  // With HTMLAudioElement, there is no AudioContext to resume.
  // The element continues playing through screen lock on both iOS and Android.
  // We just need to check if we've drifted and resync if needed.
  if (!audioEl || audioDuration === 0) return;

  if (masterIsPlaying) {
    if (!isPlaying) {
      // Should be playing but isn't (e.g. interrupted by a phone call)
      setSyncStatus('drifted', 'Resyncing after background…');
      const targetRaw = getEstimatedMasterPosition();
      await startPlayback(targetRaw - (manualOffsetMs / 1000));
      setSyncStatus('synced', 'In sync');
    } else {
      // Check drift
      const actualPos   = audioEl.currentTime;
      const expectedPos = getEstimatedMasterPosition() + (manualOffsetMs / 1000);
      const drift       = (actualPos - expectedPos) * 1000;
      if (Math.abs(drift) > 300) {
        setSyncStatus('drifted', 'Resyncing after background…');
        const targetRaw = getEstimatedMasterPosition();
        await startPlayback(targetRaw - (manualOffsetMs / 1000));
        setSyncStatus('synced', 'In sync');
      }
    }
  }
});

// ── Service Worker Setup ──────────────────────────────────────────────────────
async function registerSyncWorker(wsUrl: string): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    console.warn('SW not supported — using direct WebSocket');
    startDirectWebSocket(wsUrl);
    return;
  }

  navigator.serviceWorker.addEventListener('message', handleSWMessage);

  const initSW = (sw: ServiceWorker) => {
    syncSW = sw;
    sw.postMessage({ type: 'sw_init', wsUrl, showId });
    console.log('[SW] sw_init sent to', sw.state);
  };

  if (navigator.serviceWorker.controller) {
    initSW(navigator.serviceWorker.controller);
    return;
  }

  await new Promise<void>(resolve => {
    let resolved = false;
    const done = (useSW: boolean, sw?: ServiceWorker) => {
      if (resolved) return;
      resolved = true;
      if (useSW && sw) {
        initSW(sw);
      } else {
        console.warn('[SW] Timed out waiting for controller — using direct WebSocket');
        startDirectWebSocket(wsUrl);
      }
      resolve();
    };

    const timeout = setTimeout(() => done(false), 4000);

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(timeout);
      done(true, navigator.serviceWorker.controller!);
    }, { once: true });

    navigator.serviceWorker.ready.then(reg => {
      if (navigator.serviceWorker.controller) {
        clearTimeout(timeout);
        done(true, navigator.serviceWorker.controller);
      } else if (reg.active) {
        // SW active but not claimed yet — controllerchange will fire
      }
    });
  });
}

// ── Fallback: Direct WebSocket (when Service Worker not available) ─────────────
function startDirectWebSocket(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  let clockOffsetDirect = 0;
  let pingTimerDirect: ReturnType<typeof setInterval> | null = null;
  let burstSentDirect = 0;
  const BURST = 16;
  const rttHist: number[] = [];
  const offHist: number[] = [];

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', role: 'audience', clientId: `direct-${Date.now()}` }));
    const burst = () => {
      ws.send(JSON.stringify({ type: 'ping', clientTs: Date.now() }));
      burstSentDirect++;
      if (burstSentDirect < BURST) setTimeout(burst, 75);
      else pingTimerDirect = setInterval(() => ws.send(JSON.stringify({ type: 'ping', clientTs: Date.now() })), 4000);
    };
    burst();
    handleSWMessage({ data: { type: 'sw_connected' } } as MessageEvent);
  };

  ws.onmessage = (e) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'pong') {
      const clientTs = msg.clientTs as number;
      const serverTs = msg.serverTs as number;
      const now = Date.now();
      const rtt = now - clientTs;
      rttHist.push(rtt); if (rttHist.length > 8) rttHist.shift();
      const offset = serverTs - (clientTs + rtt / 2);
      offHist.push(offset); if (offHist.length > 16) offHist.shift();
      const sorted = [...offHist].sort((a, b) => a - b);
      clockOffsetDirect = sorted[Math.floor(sorted.length / 2)];
      handleSWMessage({ data: { type: 'sw_clock', clockOffsetMs: clockOffsetDirect, rttMs: rtt, burstComplete: burstSentDirect >= BURST } } as MessageEvent);
      return;
    }

    if (msg.type === 'welcome' || msg.type === 'sync') {
      const receivedAt = Date.now();
      const rawPos = (msg.position as number) || 0;
      const serverTs = (msg.serverTs as number) || receivedAt;
      const isPlay = !!(msg.isPlaying || msg.action === 'play');
      const action = (msg.action as string) || (isPlay ? 'play' : 'pause');
      let correctedPos = rawPos;
      if (action === 'play') {
        const serverNow = receivedAt + clockOffsetDirect;
        const transit = Math.max(0, serverNow - serverTs);
        correctedPos = rawPos + transit / 1000;
      }
      handleSWMessage({ data: { type: 'sw_command', action, position: correctedPos, serverTs, masterTs: msg.masterTs || 0, audioFile: msg.audioFile || null, receivedAt, clockOffsetMs: clockOffsetDirect } } as MessageEvent);
    }

    if (msg.type === 'audio_ready') {
      handleSWMessage({ data: { type: 'sw_audio_ready', audioFile: msg.audioFile, audioHash: msg.audioHash } } as MessageEvent);
    }
  };

  ws.onclose = () => {
    if (pingTimerDirect) clearInterval(pingTimerDirect);
    handleSWMessage({ data: { type: 'sw_disconnected' } } as MessageEvent);
    setTimeout(() => startDirectWebSocket(wsUrl), 3000);
  };
}

// ── Join Flow ─────────────────────────────────────────────────────────────────
async function joinShow() {
  showId        = joinShowIdInput.value.trim();
  serverBaseUrl = joinServerUrlInput.value.trim().replace(/\/$/, '');

  if (!showId || !serverBaseUrl) {
    alert('Please enter both a Show ID and Server URL.');
    return;
  }

  localStorage.setItem('cinewav_show_id',    showId);
  localStorage.setItem('cinewav_server_url', serverBaseUrl);

  joinBtn.disabled    = true;
  joinBtn.textContent = 'Connecting…';

  try {
    // ── 1. Fetch show state ───────────────────────────────────────────────────
    const stateRes = await fetch(`${serverBaseUrl}/api/show/${showId}/state`);
    if (!stateRes.ok) throw new Error(`Server error: ${stateRes.status}`);
    const state = await stateRes.json() as {
      audioFile?:  string;
      audioHash?:  string;
      audioReady?: boolean;
      isPlaying:   boolean;
      position:    number;
    };

    // ── 2. Check local audio cache ────────────────────────────────────────────
    let audioData = await loadAudio(showId);
    if (audioData && state.audioHash && audioData.hash !== state.audioHash) {
      audioData = null;
    }

    // ── 3. Download audio if needed ───────────────────────────────────────────
    if (!audioData && state.audioReady && state.audioFile) {
      const buf = await downloadAudioFile(
        `${serverBaseUrl}/api/show/${showId}/audio`,
        state.audioFile,
      );
      await saveAudio(showId, state.audioFile, buf, state.audioHash || '');
      audioData = { filename: state.audioFile, hash: state.audioHash || '', data: buf };
    }

    // ── 4. Show player screen ─────────────────────────────────────────────────
    showScreen('player');
    showIdDisplay.textContent = `Show: ${showId}`;
    setupMediaSession(audioData?.filename || 'Cinewav Show');
    syncControlsEl.style.display = 'flex';
    loadManualOffset();
    playPauseBtn.disabled = true;
    resyncBtn.disabled    = true;
    trackName.textContent = audioData?.filename || 'Waiting for audio…';

    // ── 5. Set initial master state from HTTP response ────────────────────────
    masterIsPlaying  = state.isPlaying;
    masterPosition   = state.position;
    masterPositionAt = Date.now();

    // ── 6. Connect Service Worker WebSocket ───────────────────────────────────
    const wsUrl = serverBaseUrl.replace(/^http/, 'ws') + `/api/show/${showId}/ws`;
    await registerSyncWorker(wsUrl);
    setSyncStatus('syncing', 'Syncing clock…');

    // ── 7. Init audio (parallel with WS — commands queued in pendingCommand) ──
    if (audioData) {
      await initAudio(audioData.data);
      trackName.textContent = audioData.filename;
      setupMediaSession(audioData.filename);

      if (pendingCommand) {
        const cmd = pendingCommand;
        pendingCommand = null;
        if (cmd.action === 'play') {
          const elapsed = (Date.now() - cmd.receivedAt) / 1000;
          cmd.position += elapsed;
          masterPosition   = cmd.position;
          masterPositionAt = Date.now();
        }
        await handleShowCommand(cmd);
      } else if (state.isPlaying) {
        const masterPos = getEstimatedMasterPosition();
        await startPlayback(masterPos - (manualOffsetMs / 1000));
        setSyncStatus('synced', 'In sync');
      }
    }

  } catch (err) {
    showError(err instanceof Error ? err.message : 'Failed to join show');
  }
}

// ── Initialisation ────────────────────────────────────────────────────────────
parseUrlParams();

const savedShowId    = localStorage.getItem('cinewav_show_id');
const savedServerUrl = localStorage.getItem('cinewav_server_url');
if (savedShowId    && !joinShowIdInput.value)    joinShowIdInput.value    = savedShowId;
if (savedServerUrl && !joinServerUrlInput.value) joinServerUrlInput.value = savedServerUrl;

joinBtn.addEventListener('click', () => {
  joinShow().catch(err => showError(err instanceof Error ? err.message : String(err)));
});

[joinShowIdInput, joinServerUrlInput].forEach(input => {
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') joinBtn.click();
  });
});

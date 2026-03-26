/**
 * Cinewav Audience PWA — Main App v6
 *
 * SPEC:
 *  - Join at any time and find sync quickly
 *  - Stay in sync via drift detection every 500ms
 *  - Hard resync if drift > +150ms (ahead) or > -300ms (behind)
 *  - Continue playing through screen lock on iOS and Android
 *  - Respond to all master commands: play, pause, seek, restart
 *  - RESYNC button forces immediate hard resync
 *  - Fine-tune buttons shift audio immediately by ±100ms
 *  - Session never closes — always listening for commands
 *
 * PLAYBACK ENGINE: HTMLAudioElement (Blob URL)
 *  - Persistent element, never recreated
 *  - Survives screen lock on iOS and Android natively
 *  - .currentTime is always writable — seek, restart, fine-tune all work
 *
 * DRIFT CORRECTION:
 *  - Measured every 500ms against getEstimatedMasterPosition()
 *  - Ahead by >150ms OR behind by >300ms → hard seek to correct position
 *  - 3-second cooldown between automatic resyncs to avoid thrash
 *  - NO playbackRate nudging — causes iOS re-buffer glitches
 *
 * CLOCK SYNC: NTP-style via Service Worker WebSocket pings
 *  - masterPosition + (Date.now() - masterPositionAt) / 1000
 *  - masterPositionAt is set from cmd.receivedAt (SW-corrected timestamp)
 */

import { saveAudio, loadAudio } from './audioStorage';

// ── Types ─────────────────────────────────────────────────────────────────────
interface ShowCommand {
  action:       'play' | 'pause' | 'seek' | 'load';
  position:     number;       // seconds, transit-corrected
  serverTs:     number;
  masterTs:     number;
  audioFile:    string | null;
  receivedAt:   number;       // client wall-clock ms when SW received this
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

// Persistent audio element — created once on first audio load, never destroyed.
let audioEl:      HTMLAudioElement | null = null;
let audioBlobUrl: string | null           = null;
let audioDuration = 0;

// isPlaying: true only when WE have called audioEl.play() and it resolved.
// Set to false before audioEl.pause() so the 'pause' event listener
// can distinguish our own pauses from external OS interruptions.
let isPlaying = false;

// isSeekingInternal: true during the pause+seek+play sequence inside
// startPlayback(), so the 'pause' event listener ignores our internal pause.
let isSeekingInternal = false;

// Manual fine-tune offset (persisted per show in localStorage)
let manualOffsetMs = 0;

// Show / server info
let showId        = '';
let serverBaseUrl = '';

// Clock state (updated from Service Worker NTP pings)
let clockOffsetMs = 0;
let rttMs         = 0;

// Stats for display
let resyncs = 0;
let driftMs = 0;

// Master state — updated on every command received from the server.
// getEstimatedMasterPosition() uses these to compute where the master is NOW.
let masterIsPlaying  = false;
let masterPosition   = 0;      // seconds at time of last command
let masterPositionAt = 0;      // Date.now() when masterPosition was last set

// Pending command received before audio was loaded
let pendingCommand: ShowCommand | null = null;

// Service Worker reference
let syncSW: ServiceWorker | null = null;

// Drift loop
let uiInterval:    ReturnType<typeof setInterval> | null = null;
let driftInterval: ReturnType<typeof setInterval> | null = null;

// Drift thresholds (per spec)
const DRIFT_CHECK_MS        = 500;   // check every 500ms
const RESYNC_AHEAD_MS       = 150;   // resync if >150ms ahead of master
const RESYNC_BEHIND_MS      = 300;   // resync if >300ms behind master
const RESYNC_COOLDOWN_MS    = 3000;  // minimum 3s between automatic resyncs
const RESYNC_CONFIRM_CHECKS = 2;     // require N consecutive out-of-range readings before resyncing
                                     // prevents a single noisy clock reading from triggering a glitch
let   lastResyncAt          = 0;
let   driftOutOfRangeCount  = 0;     // consecutive out-of-range drift readings

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

// ── Audio Engine ──────────────────────────────────────────────────────────────

/**
 * Detect MIME type from first 12 bytes of the audio file.
 */
function detectMimeType(arrayBuffer: ArrayBuffer): string {
  const h = new Uint8Array(arrayBuffer, 0, 12);
  // MP4/M4A: 'ftyp' at byte 4
  if (h[4]===0x66 && h[5]===0x74 && h[6]===0x79 && h[7]===0x70) return 'audio/mp4';
  // MP4/M4A: 'ftyp' at byte 0 (some variants)
  if (h[0]===0x66 && h[1]===0x74 && h[2]===0x79 && h[3]===0x70) return 'audio/mp4';
  // OGG: 'OggS'
  if (h[0]===0x4F && h[1]===0x67 && h[2]===0x67 && h[3]===0x53) return 'audio/ogg';
  // Default: MP3
  return 'audio/mpeg';
}

/**
 * Initialize the persistent HTMLAudioElement from an ArrayBuffer.
 * Creates a Blob URL so the OS treats it as a real audio file.
 * Called once; subsequent seeks use audioEl.currentTime directly.
 */
async function initAudio(arrayBuffer: ArrayBuffer): Promise<void> {
  if (audioBlobUrl) {
    URL.revokeObjectURL(audioBlobUrl);
    audioBlobUrl = null;
  }

  const mimeType = detectMimeType(arrayBuffer);
  const blob = new Blob([arrayBuffer], { type: mimeType });
  audioBlobUrl = URL.createObjectURL(blob);

  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';

    // ── ended: film finished naturally ──────────────────────────────────────
    audioEl.addEventListener('ended', () => {
      // Mark as not playing so the drift loop and visibility handler know
      // to restart when the master sends a new play command.
      // Do NOT clear masterIsPlaying — the master may still be "playing"
      // (e.g. it looped or restarted) and we need to respond to its commands.
      isPlaying = false;
      albumArt.classList.remove('playing');
      stopLoops();
      updatePlayPauseBtn();
      updateMediaSession();
      setSyncStatus('synced', 'Show ended — waiting for master');
    });

    // ── pause: fired by OS (screen lock, phone call, Bluetooth) ────────────
    // We distinguish external OS pauses from our own internal pauses:
    //  - stopPlayback() sets isPlaying=false BEFORE calling audioEl.pause()
    //    → isPlaying is already false here → if(isPlaying) is a no-op
    //  - startPlayback() sets isSeekingInternal=true before its internal pause()
    //    → early return via isSeekingInternal check
    // Only genuine external interruptions reach the body of this handler.
    audioEl.addEventListener('pause', () => {
      if (isSeekingInternal) return;
      if (isPlaying) {
        // External OS interruption — mark state so visibilitychange can recover
        isPlaying = false;
        albumArt.classList.remove('playing');
        stopLoops();
        updatePlayPauseBtn();
        updateMediaSession();
        setSyncStatus('drifted', 'Audio interrupted');
      }
    });

    // ── loadedmetadata: update duration display ─────────────────────────────
    audioEl.addEventListener('loadedmetadata', () => {
      audioDuration = audioEl!.duration;
      pTotalTime.textContent = formatTime(audioDuration);
    });
  }

  audioEl.src = audioBlobUrl;

  // Wait for metadata so we have the correct duration
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

// ── Position Estimation ───────────────────────────────────────────────────────

/**
 * Estimate where the master player is RIGHT NOW, in seconds.
 * masterPosition and masterPositionAt are updated on every command received.
 */
function getEstimatedMasterPosition(): number {
  if (!masterIsPlaying) return masterPosition;
  return masterPosition + (Date.now() - masterPositionAt) / 1000;
}

// ── Playback Control ──────────────────────────────────────────────────────────

function stopLoops() {
  if (uiInterval)    { clearInterval(uiInterval);    uiInterval    = null; }
  if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
}

/**
 * Stop playback cleanly.
 * Sets isPlaying=false BEFORE calling audioEl.pause() so the 'pause' event
 * listener sees isPlaying=false and treats it as an internal pause (no-op).
 */
function stopPlayback() {
  isPlaying = false;
  stopLoops();
  if (audioEl) {
    audioEl.pause();
  }
  albumArt.classList.remove('playing');
  updatePlayPauseBtn();
  updateMediaSession();
}

/**
 * Seek to rawPosition (seconds, WITHOUT manual offset) and start playing.
 * manualOffsetMs is applied internally.
 *
 * Safe to call while already playing — always pauses first to avoid iOS
 * AbortError from seek-while-playing.
 */
async function startPlayback(rawPosition: number): Promise<void> {
  if (!audioEl || audioDuration === 0) return;

  stopLoops();

  const adjusted = rawPosition + (manualOffsetMs / 1000);
  const clamped  = Math.max(0, Math.min(adjusted, audioDuration - 0.05));

  // Guard the 'pause' event listener during our internal pause+seek sequence
  isSeekingInternal = true;
  audioEl.pause();
  audioEl.currentTime = clamped;

  try {
    await audioEl.play();
  } catch (err: unknown) {
    isSeekingInternal = false;
    if (err instanceof Error && err.name === 'AbortError') {
      // A newer play() call superseded this one — safe to ignore
      return;
    }
    if (err instanceof Error && err.name === 'NotAllowedError') {
      // Needs a user gesture — show tap-to-play prompt
      isPlaying = false;
      updatePlayPauseBtn();
      setSyncStatus('syncing', 'Tap play to start');
      return;
    }
    console.warn('[Audio] play() error:', err);
    return;
  }

  isSeekingInternal = false;

  // Reset the resync cooldown and consecutive-drift counter from NOW so the
  // drift loop doesn't immediately fire again after we just seeked.
  lastResyncAt         = Date.now();
  driftOutOfRangeCount = 0;

  isPlaying = true;
  albumArt.classList.add('playing');
  waitingOverlay.classList.add('hidden');
  updatePlayPauseBtn();
  updateMediaSession();
  startUILoop();
  startDriftLoop();
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
  }, 250);
}

// ── Drift Detection Loop ──────────────────────────────────────────────────────
function startDriftLoop() {
  if (driftInterval) clearInterval(driftInterval);
  driftInterval = setInterval(() => {
    if (!isPlaying || !audioEl) return;

    const actualPos   = audioEl.currentTime;
    const expectedPos = getEstimatedMasterPosition() + (manualOffsetMs / 1000);
    driftMs = (actualPos - expectedPos) * 1000;

    statDrift.textContent = `${driftMs >= 0 ? '+' : ''}${Math.round(driftMs)}ms`;

    const abs = Math.abs(driftMs);
    if      (abs < 50)  setSyncStatus('synced',  'In sync');
    else if (abs < 150) setSyncStatus('syncing', `${Math.round(abs)}ms drift`);
    else                setSyncStatus('drifted', `${Math.round(abs)}ms drift`);

    // Hard resync if:
    //  - ahead by more than RESYNC_AHEAD_MS (+150ms), OR
    //  - behind by more than RESYNC_BEHIND_MS (-300ms)
    // AND the cooldown has elapsed (prevents thrash)
    // AND we've seen N consecutive out-of-range readings (prevents single noisy
    //   clock sample from triggering a glitch)
    const needsResync = (driftMs > RESYNC_AHEAD_MS) || (driftMs < -RESYNC_BEHIND_MS);
    const cooldownOk  = (Date.now() - lastResyncAt) >= RESYNC_COOLDOWN_MS;

    if (needsResync) {
      driftOutOfRangeCount++;
    } else {
      driftOutOfRangeCount = 0;  // reset on any in-range reading
    }

    if (needsResync && cooldownOk && masterIsPlaying && driftOutOfRangeCount >= RESYNC_CONFIRM_CHECKS) {
      driftOutOfRangeCount = 0;
      resyncs++;
      statResyncs.textContent = String(resyncs);
      setSyncStatus('syncing', 'Auto-resyncing…');
      const targetRaw = getEstimatedMasterPosition();
      startPlayback(targetRaw - (manualOffsetMs / 1000));
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
  // Disable lock screen transport controls — the master controls playback.
  // If we leave these enabled, iOS/Android will show play/pause/seek buttons
  // that would let the audience control their own audio independently.
  navigator.mediaSession.setActionHandler('play',         null);
  navigator.mediaSession.setActionHandler('pause',        null);
  navigator.mediaSession.setActionHandler('seekto',       null);
  navigator.mediaSession.setActionHandler('seekforward',  null);
  navigator.mediaSession.setActionHandler('seekbackward', null);
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  // Only set playbackState — do NOT call setPositionState().
  // setPositionState() triggers OS media events on iOS/Android that cause
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
    // Jump to where the master is right now
    const rawPos = getEstimatedMasterPosition();
    await startPlayback(rawPos - (manualOffsetMs / 1000));
    setSyncStatus('synced', 'In sync');
  }
});

// ── Show Command Handler ──────────────────────────────────────────────────────
/**
 * Handle a command from the master player.
 *
 * Master sends:
 *  - 'play'  — when play is pressed, or when seeking while playing
 *  - 'pause' — when pause is pressed
 *  - 'seek'  — when seeking while paused
 *  - 'load'  — when a new audio file is loaded
 *
 * cmd.position is already transit-corrected by the Service Worker.
 * cmd.receivedAt is the client wall-clock ms when the SW received the message.
 */
async function handleShowCommand(cmd: ShowCommand) {
  if (!audioEl || audioDuration === 0) {
    // Audio not loaded yet — queue the command
    pendingCommand = cmd;
    return;
  }

  // Update master state.
  // IMPORTANT: masterPositionAt MUST use Date.now() on the main thread.
  // cmd.receivedAt is from the SW thread clock, which can skew relative to
  // the main thread clock on iOS (especially with screen lock throttling).
  // Using two different clocks in the drift calculation causes false drift readings.
  //
  // Transit correction is already baked into cmd.position by the SW's
  // broadcastCommand() function for 'play' actions.
  const now = Date.now();
  if (cmd.action === 'play') {
    masterIsPlaying  = true;
    masterPosition   = cmd.position;
    masterPositionAt = now;
  } else if (cmd.action === 'pause') {
    masterIsPlaying  = false;
    masterPosition   = cmd.position;
    masterPositionAt = now;
  } else if (cmd.action === 'seek') {
    masterIsPlaying  = false;  // seek is only sent when paused
    masterPosition   = cmd.position;
    masterPositionAt = now;
  }
  // 'load' doesn't update position tracking

  setSyncStatus('syncing', 'Syncing…');

  switch (cmd.action) {
    case 'play': {
      // Master is playing — start from the transit-corrected position
      await startPlayback(cmd.position - (manualOffsetMs / 1000));
      setSyncStatus('synced', 'In sync');
      if (cmd.audioFile) trackName.textContent = cmd.audioFile;
      break;
    }

    case 'pause': {
      stopPlayback();
      // Seek to exact pause position so next play starts from the right spot
      if (audioEl) {
        audioEl.currentTime = Math.max(0, Math.min(cmd.position, audioDuration));
      }
      setSyncStatus('synced', 'Paused');
      break;
    }

    case 'seek': {
      // Master seeked while paused — move to new position, stay paused
      stopPlayback();
      if (audioEl) {
        audioEl.currentTime = Math.max(0, Math.min(cmd.position, audioDuration));
      }
      setSyncStatus('synced', 'Paused');
      break;
    }

    case 'load': {
      stopPlayback();
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
    // Master is paused — seek to its position and stay paused
    stopPlayback();
    if (audioEl) {
      audioEl.currentTime = Math.max(0, Math.min(masterPos, audioDuration));
    }
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
/**
 * Apply a new manual offset immediately.
 * The old offset was baked into audioEl.currentTime — strip it to get the
 * raw position, then re-apply the new offset via startPlayback().
 */
function applyOffsetChange(oldOffsetMs: number) {
  if (!audioEl || !isPlaying) return;
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

// ── Visibility Change — Screen Wake Recovery ──────────────────────────────────
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;

  // Screen came back on — request a fresh clock sync burst from the SW
  sendToSW({ type: 'sw_hard_resync' });

  if (!audioEl || audioDuration === 0) return;

  if (masterIsPlaying) {
    if (!isPlaying) {
      // Should be playing but isn't (OS interrupted while screen was off)
      setSyncStatus('drifted', 'Resyncing after screen lock…');
      const targetRaw = getEstimatedMasterPosition();
      await startPlayback(targetRaw - (manualOffsetMs / 1000));
      setSyncStatus('synced', 'In sync');
    } else {
      // Is playing — check if we've drifted significantly
      const actualPos   = audioEl.currentTime;
      const expectedPos = getEstimatedMasterPosition() + (manualOffsetMs / 1000);
      const drift       = (actualPos - expectedPos) * 1000;
      if (drift > RESYNC_AHEAD_MS || drift < -RESYNC_BEHIND_MS) {
        setSyncStatus('drifted', 'Resyncing after screen lock…');
        const targetRaw = getEstimatedMasterPosition();
        await startPlayback(targetRaw - (manualOffsetMs / 1000));
        setSyncStatus('synced', 'In sync');
      }
    }
  }
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
        action:        msg.action,
        position:      msg.position,
        serverTs:      msg.serverTs,
        masterTs:      msg.masterTs,
        audioFile:     msg.audioFile,
        receivedAt:    msg.receivedAt,
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
  if (existing?.hash === hash) {
    // Already have the right audio — no need to re-download
    return;
  }
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

// ── Service Worker Setup ──────────────────────────────────────────────────────
async function registerSyncWorker(wsUrl: string): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    console.warn('[SW] Not supported — using direct WebSocket');
    startDirectWebSocket(wsUrl);
    return;
  }

  navigator.serviceWorker.addEventListener('message', handleSWMessage);

  const initSW = (sw: ServiceWorker) => {
    syncSW = sw;
    sw.postMessage({ type: 'sw_init', wsUrl, showId });
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
        console.warn('[SW] Timed out — using direct WebSocket');
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

// ── Fallback: Direct WebSocket ────────────────────────────────────────────────
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
      const rawPos  = (msg.position as number) || 0;
      const serverTs = (msg.serverTs as number) || receivedAt;
      const isPlay  = !!(msg.isPlaying || msg.action === 'play');
      const action  = (msg.action as string) || (isPlay ? 'play' : 'pause');
      let correctedPos = rawPos;
      if (action === 'play') {
        const serverNow = receivedAt + clockOffsetDirect;
        const transit   = Math.max(0, serverNow - serverTs);
        correctedPos    = rawPos + transit / 1000;
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
    // 1. Fetch current show state from server
    const stateRes = await fetch(`${serverBaseUrl}/api/show/${showId}/state`);
    if (!stateRes.ok) throw new Error(`Server error: ${stateRes.status}`);
    const state = await stateRes.json() as {
      audioFile?:  string;
      audioHash?:  string;
      audioReady?: boolean;
      isPlaying:   boolean;
      position:    number;
      serverTs?:   number;
    };

    // 2. Check local audio cache
    let audioData = await loadAudio(showId);
    if (audioData && state.audioHash && audioData.hash !== state.audioHash) {
      audioData = null; // stale — will re-download
    }

    // 3. Download audio if needed
    if (!audioData && state.audioReady && state.audioFile) {
      const buf = await downloadAudioFile(
        `${serverBaseUrl}/api/show/${showId}/audio`,
        state.audioFile,
      );
      await saveAudio(showId, state.audioFile, buf, state.audioHash || '');
      audioData = { filename: state.audioFile, hash: state.audioHash || '', data: buf };
    }

    // 4. Show player screen
    showScreen('player');
    showIdDisplay.textContent = `Show: ${showId}`;
    setupMediaSession(audioData?.filename || 'Cinewav Show');
    syncControlsEl.style.display = 'flex';
    loadManualOffset();
    playPauseBtn.disabled = true;
    resyncBtn.disabled    = true;
    trackName.textContent = audioData?.filename || 'Waiting for audio…';

    // 5. Set initial master state from HTTP response.
    // Correct for transit time if master was playing when we fetched state.
    const fetchedAt = Date.now();
    masterIsPlaying  = state.isPlaying;
    if (state.isPlaying && state.serverTs) {
      // Advance position by how long it took to receive the state
      const transitMs = Math.max(0, fetchedAt - state.serverTs);
      masterPosition   = state.position + transitMs / 1000;
    } else {
      masterPosition = state.position;
    }
    masterPositionAt = fetchedAt;

    // 6. Connect Service Worker WebSocket
    const wsUrl = serverBaseUrl.replace(/^http/, 'ws') + `/api/show/${showId}/ws`;
    await registerSyncWorker(wsUrl);
    setSyncStatus('syncing', 'Syncing clock…');

    // 7. Init audio (commands queued in pendingCommand while audio loads)
    if (audioData) {
      await initAudio(audioData.data);
      trackName.textContent = audioData.filename;
      setupMediaSession(audioData.filename);

      if (pendingCommand) {
        // A command arrived while we were loading audio — apply it now,
        // correcting for the time that passed since it was received.
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
        // No pending command — start from our estimated master position
        const masterPos = getEstimatedMasterPosition();
        await startPlayback(masterPos - (manualOffsetMs / 1000));
        setSyncStatus('synced', 'In sync');
      } else {
        // Master is paused — seek to its position and wait
        if (audioEl) {
          audioEl.currentTime = Math.max(0, Math.min(masterPosition, audioDuration));
        }
        setSyncStatus('synced', 'Paused — waiting for master');
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

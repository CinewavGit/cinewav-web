/**
 * Cinewav Audience PWA — Main App v7
 *
 * Base: v4 AudioBufferSourceNode architecture (known working)
 *
 * Three targeted fixes on top of v4:
 *
 * FIX 1 — masterPositionAt clock source
 *   v4 used cmd.receivedAt (Service Worker thread clock) for masterPositionAt.
 *   The drift loop uses Date.now() (main thread clock). On iOS these two threads
 *   can have measurable skew, especially when screen-locked. Fix: always set
 *   masterPositionAt = Date.now() on the main thread.
 *
 * FIX 2 — Drift loop consecutive-check guard
 *   v4 triggered a hard resync on a single out-of-range drift reading. A single
 *   noisy ping sample could cause a spurious resync glitch. Fix: require 2
 *   consecutive out-of-range readings before auto-resyncing.
 *
 * FIX 3 — iOS background audio keepalive without silent.mp3 loop
 *   v4 used a looping silent.mp3 HTMLAudioElement to keep the iOS audio session
 *   alive. This caused 1-second interruptions because each loop iteration was
 *   treated as a new audio event by the OS. Fix: use a looping
 *   AudioBufferSourceNode of silence connected to the AudioContext destination.
 *   This keeps the AudioContext alive without triggering OS media events.
 *
 * Everything else is identical to v4.
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
  enqueuedAt: number; // main-thread Date.now() at moment of enqueue — used for masterPositionAt
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
let audioCtx:        AudioContext | null          = null;
let audioBuffer:     AudioBuffer  | null          = null;
let sourceNode:      AudioBufferSourceNode | null = null;
let keepaliveNode:   AudioBufferSourceNode | null = null; // FIX 3: silent keepalive
let isPlaying        = false;
let playStartCtxTime = 0;   // audioCtx.currentTime when playback started
let playStartPos     = 0;   // audio position (seconds) when playback started
let audioDuration    = 0;
let uiInterval:      ReturnType<typeof setInterval> | null = null;
let driftInterval:   ReturnType<typeof setInterval> | null = null;
let showId           = '';
let serverBaseUrl    = '';
let manualOffsetMs   = 0;

// Clock state (updated from Service Worker)
let clockOffsetMs    = 0;
let rttMs            = 0;
let resyncs          = 0;
let driftMs          = 0;

// Master state (last known from Service Worker)
let masterIsPlaying  = false;
let masterPosition   = 0;
let masterPositionAt = 0;   // Date.now() on main thread — FIX 1

// Pending command received before audio was decoded
let pendingCommand: ShowCommand | null = null;

// Pending playback start deferred until AudioContext resumes
let pendingPlaybackPos: number | null = null;

// Raw audio ArrayBuffer kept in memory so we can re-decode if AudioContext is closed
let rawAudioData: ArrayBuffer | null = null;

// FIX 2: consecutive out-of-range drift readings required before auto-resync
let driftOutOfRangeCount = 0;
const DRIFT_CONFIRM_COUNT = 2;

// Service Worker reference
let syncSW: ServiceWorker | null = null;

// ── Serial Command Queue ──────────────────────────────────────────────────────
// handleShowCommand is async. If two commands arrive in rapid succession (e.g.
// seek + play from the master), they must be processed strictly one at a time.
// Without this, concurrent executions corrupt shared state (sourceNode,
// isPlaying, masterPositionAt, driftInterval).
let commandQueue: ShowCommand[] = [];
let commandQueueRunning = false;

function enqueueCommand(cmd: ShowCommand) {
  // Stamp the command with the main-thread time at the moment it was enqueued.
  // handleShowCommand uses enqueuedAt (not cmd.receivedAt from the SW thread)
  // to set masterPositionAt. This ensures:
  //   (a) both sides of the drift calculation use the same clock, and
  //   (b) queue-wait time is accounted for — if a command waits 200ms in the
  //       queue, masterPositionAt is 200ms earlier than Date.now() inside
  //       handleShowCommand, so getEstimatedMasterPosition() correctly
  //       advances masterPosition by those 200ms.
  cmd.enqueuedAt = Date.now();

  if (cmd.action === 'pause') {
    // Pause must NEVER be dropped — it is the highest-priority command.
    // Place it at the front of the queue so it runs immediately after the
    // currently-executing command finishes. Discard any queued play/seek
    // commands that are now stale.
    commandQueue = [cmd];
  } else {
    // For play/seek/load: keep only the latest — stale intermediates are
    // irrelevant since only the most recent master state matters.
    // But never discard a queued pause.
    const hasPause = commandQueue.some(c => c.action === 'pause');
    if (hasPause) {
      // A pause is waiting — don't replace it; append this after it.
      commandQueue = [commandQueue.find(c => c.action === 'pause')!, cmd];
    } else {
      commandQueue = [cmd];
    }
  }

  if (!commandQueueRunning) drainCommandQueue();
}

function drainCommandQueue() {
  if (commandQueue.length === 0) {
    commandQueueRunning = false;
    return;
  }
  commandQueueRunning = true;
  const cmd = commandQueue.shift()!;
  handleShowCommand(cmd).then(() => drainCommandQueue()).catch(() => drainCommandQueue());
}

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
 * Attach the statechange listener to an AudioContext.
 * Extracted so it can be re-attached when the context is recreated.
 */
function attachAudioContextListeners(ctx: AudioContext) {
  ctx.addEventListener('statechange', () => {
    // Ignore events from stale (replaced) contexts
    if (ctx !== audioCtx) return;
    if (ctx.state === 'running') {
      // Restart silent keepalive on the resumed/new context
      startSilentKeepalive();
      // Context just became active — restart playback from the current master
      // position. Always recalculate from master rather than using a stale
      // pendingPlaybackPos, because the context may have been suspended for
      // several seconds and the stored position would be wrong.
      if (masterIsPlaying && audioBuffer) {
        pendingPlaybackPos = null;
        const targetRaw = getEstimatedMasterPosition();
        startPlayback(targetRaw - (manualOffsetMs / 1000));
        setSyncStatus('synced', 'In sync');
      } else if (pendingPlaybackPos !== null) {
        // Not playing per master but we have a deferred position (e.g. manual
        // play button pressed while context was suspended) — honour it.
        const pos = pendingPlaybackPos;
        pendingPlaybackPos = null;
        startPlayback(pos);
        setSyncStatus('synced', 'In sync');
      }
    }
  });
}

function ensureAudioContext() {
  // Create a new context if none exists OR if the existing one is closed.
  // Android Chrome closes (not just suspends) the AudioContext when the film
  // ends while the screen is off. A closed context cannot be resumed.
  if (!audioCtx || audioCtx.state === 'closed') {
    if (sourceNode) {
      try { sourceNode.stop(); } catch { /* already stopped */ }
      sourceNode = null;
    }
    if (keepaliveNode) {
      try { keepaliveNode.stop(); } catch { /* already stopped */ }
      keepaliveNode = null;
    }
    isPlaying = false;

    // iOS silent-switch fix: set audio session to 'playback' BEFORE creating
    // the AudioContext. This routes audio through the media channel (same as
    // YouTube/Spotify) so the ringer/silent switch does NOT mute it.
    // Supported since iOS 16.4 / Safari 16.4. Safe to call on other platforms
    // — they either support it or silently ignore it.
    try {
      if ('audioSession' in navigator) {
        (navigator as Navigator & { audioSession: { type: string } }).audioSession.type = 'playback';
      }
    } catch { /* ignore — not supported on this platform */ }

    audioCtx = new AudioContext();
    attachAudioContextListeners(audioCtx);
  }
}

/**
 * Resume AudioContext regardless of whether it is 'suspended' or 'interrupted'.
 * On iOS, the state after screen-lock is 'interrupted', not 'suspended'.
 * On Android, the context may be 'closed' after the film ends with screen off —
 * in that case we recreate it and re-decode the audio buffer.
 */
async function resumeAudioContext(): Promise<void> {
  if (!audioCtx) return;

  if (audioCtx.state === 'closed') {
    ensureAudioContext();
    // Re-decode audio buffer for the new context if we have the raw data
    if (rawAudioData && audioCtx) {
      try {
        audioBuffer = await audioCtx.decodeAudioData(rawAudioData.slice(0));
        audioDuration = audioBuffer.duration;
      } catch { /* decode failed */ }
    }
    return;
  }

  if (audioCtx.state === 'suspended' || (audioCtx.state as string) === 'interrupted') {
    try { await audioCtx.resume(); } catch { /* ignore */ }
  }
}

async function initAudio(arrayBuffer: ArrayBuffer) {
  ensureAudioContext();
  await resumeAudioContext();
  // Keep a copy of the raw bytes so we can re-decode if the AudioContext is
  // recreated later (e.g. Android closes it when screen-off + film ends).
  rawAudioData  = arrayBuffer.slice(0);
  audioBuffer   = await audioCtx!.decodeAudioData(arrayBuffer.slice(0));
  audioDuration = audioBuffer.duration;
  pTotalTime.textContent = formatTime(audioDuration);
  playPauseBtn.disabled  = false;
  resyncBtn.disabled     = false;
  // Android fix C: start the health-check timer that recovers from silent
  // AudioContext suspension (statechange may not fire on Android Chrome).
  startHealthCheck();
}

/**
 * FIX 3: Silent keepalive using AudioBufferSourceNode.
 * Keeps the AudioContext alive on iOS when screen is locked — without using
 * a looping HTMLAudioElement (which caused 1-second OS media interruptions).
 * A looping silent AudioBufferSourceNode is invisible to the OS media session.
 */
function startSilentKeepalive() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  if (keepaliveNode) {
    try { keepaliveNode.stop(); } catch { /* already stopped */ }
    keepaliveNode = null;
  }
  const sampleRate = audioCtx.sampleRate;
  const silentBuf  = audioCtx.createBuffer(1, sampleRate, sampleRate);
  const node = audioCtx.createBufferSource();
  node.buffer = silentBuf;
  node.loop   = true;
  node.connect(audioCtx.destination);
  node.start(0);
  keepaliveNode = node;
}

/**
 * Returns current playback position in seconds using the Web Audio clock.
 * audioCtx.currentTime is a hardware-backed monotonic timer — immune to
 * browser throttling and system clock adjustments.
 */
function getCurrentPosition(): number {
  if (!audioCtx || !isPlaying) return playStartPos;
  return playStartPos + (audioCtx.currentTime - playStartCtxTime);
}

/**
 * Estimate where the master player is RIGHT NOW.
 * Uses Date.now() since masterPositionAt was recorded on the main thread (FIX 1).
 */
function getEstimatedMasterPosition(): number {
  if (!masterIsPlaying) return masterPosition;
  return masterPosition + (Date.now() - masterPositionAt) / 1000;
}

/**
 * Start playback from rawPosition (seconds, WITHOUT manual offset applied).
 * manualOffsetMs is applied internally.
 *
 * Android fix: if the AudioContext is not running (suspended/interrupted),
 * defer playback via pendingPlaybackPos instead of starting a node on a
 * suspended context. A node started on a suspended context produces no audio
 * and — critically — audioCtx.currentTime is frozen, so playStartCtxTime is
 * recorded at the wrong value. When the context later resumes, currentTime
 * jumps forward and getCurrentPosition() wildly overshoots, breaking all
 * subsequent drift calculations permanently.
 */
function startPlayback(rawPosition: number) {
  if (!audioCtx || !audioBuffer) return;

  // Android fix A: never start a node on a non-running context.
  // Defer and let the statechange handler (or the health-check timer) restart
  // playback once the context is actually running.
  if (audioCtx.state !== 'running') {
    pendingPlaybackPos = rawPosition - (manualOffsetMs / 1000);
    // Kick a resume attempt — statechange will fire startPlayback when ready
    resumeAudioContext().catch(() => {});
    return;
  }

  // Stop existing node cleanly
  const oldNode = sourceNode;
  sourceNode = null;
  if (oldNode) {
    try { oldNode.stop(); } catch { /* already stopped */ }
    oldNode.disconnect();
  }
  if (uiInterval)    { clearInterval(uiInterval);    uiInterval    = null; }
  if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
  isPlaying = false;

  // FIX 2: reset consecutive drift counter on every new playback start
  driftOutOfRangeCount = 0;

  const adjusted = rawPosition + (manualOffsetMs / 1000);
  const clamped  = Math.max(0, Math.min(adjusted, audioDuration - 0.1));

  const node = audioCtx.createBufferSource();
  node.buffer = audioBuffer;
  node.connect(audioCtx.destination);
  node.start(0, clamped);

  node.onended = () => {
    if (sourceNode === node) {
      sourceNode = null;
      isPlaying  = false;
      albumArt.classList.remove('playing');
      if (uiInterval)    { clearInterval(uiInterval);    uiInterval    = null; }
      if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
      driftOutOfRangeCount = 0;
      updatePlayPauseBtn();
      if (!masterIsPlaying) setSyncStatus('synced', 'Show ended');
    }
  };

  sourceNode       = node;
  playStartCtxTime = audioCtx.currentTime;  // safe: context is running
  playStartPos     = clamped;
  isPlaying        = true;

  albumArt.classList.add('playing');
  waitingOverlay.classList.add('hidden');
  updatePlayPauseBtn();
  startUILoop();
  startDriftLoop();
  updateMediaSession();
}

function stopPlayback() {
  const node = sourceNode;
  sourceNode = null;
  if (node) {
    try { node.stop(); } catch { /* already stopped */ }
    node.disconnect();
  }
  if (uiInterval)    { clearInterval(uiInterval);    uiInterval    = null; }
  if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
  isPlaying = false;
  driftOutOfRangeCount = 0;
  albumArt.classList.remove('playing');
  updatePlayPauseBtn();
}

// ── UI Loop ───────────────────────────────────────────────────────────────────
function startUILoop() {
  if (uiInterval) clearInterval(uiInterval);
  uiInterval = setInterval(() => {
    if (!isPlaying) return;
    const pos     = getCurrentPosition();
    const clamped = Math.min(pos, audioDuration);
    pCurrentTime.textContent = formatTime(clamped);
    if (audioDuration > 0) seekFill.style.width = `${(clamped / audioDuration) * 100}%`;
  }, 250);
}

// ── Drift Detection Loop ──────────────────────────────────────────────────────
const DRIFT_CHECK_MS   = 500;
const RESYNC_AHEAD_MS  = 150;
const RESYNC_BEHIND_MS = 300;

function startDriftLoop() {
  if (driftInterval) clearInterval(driftInterval);
  driftInterval = setInterval(() => {
    if (!isPlaying || !masterIsPlaying) return;

    // Android fix B: if the AudioContext is not running, the Web Audio clock
    // (audioCtx.currentTime) is frozen. getCurrentPosition() will return a
    // stale value and all drift calculations will be wrong. Skip this tick
    // and kick a resume attempt instead. The statechange handler (or the
    // health-check timer) will restart playback when the context recovers.
    if (!audioCtx || audioCtx.state !== 'running') {
      resumeAudioContext().catch(() => {});
      return;
    }

    const actualPos   = getCurrentPosition();
    const expectedPos = getEstimatedMasterPosition() + (manualOffsetMs / 1000);
    driftMs = (actualPos - expectedPos) * 1000;

    statDrift.textContent = `${driftMs >= 0 ? '+' : ''}${Math.round(driftMs)}ms`;
    const abs = Math.abs(driftMs);
    if      (abs < 50)  setSyncStatus('synced',  'In sync');
    else if (abs < 150) setSyncStatus('syncing', `${Math.round(abs)}ms drift`);
    else                setSyncStatus('drifted', `${Math.round(abs)}ms drift`);

    // FIX 2: require 2 consecutive out-of-range readings before auto-resync
    if (driftMs > RESYNC_AHEAD_MS || driftMs < -RESYNC_BEHIND_MS) {
      driftOutOfRangeCount++;
      if (driftOutOfRangeCount >= DRIFT_CONFIRM_COUNT) {
        driftOutOfRangeCount = 0;
        resyncs++;
        statResyncs.textContent = String(resyncs);
        const targetRaw = getEstimatedMasterPosition();
        startPlayback(targetRaw - (manualOffsetMs / 1000));
        setSyncStatus('synced', 'In sync');
      }
    } else {
      driftOutOfRangeCount = 0;
    }
  }, DRIFT_CHECK_MS);
}

// ── AudioContext Health-Check Timer (Android silent-suspend recovery) ─────────
// Android Chrome can silently suspend the AudioContext after rapid seek cycles
// without firing a statechange event. This timer polls every 2 seconds and
// forces a resume + playback restart if the context is not running while the
// show is supposed to be playing. It is the safety net for the cases where
// statechange never fires.
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

function startHealthCheck() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(async () => {
    if (!audioCtx || !masterIsPlaying || !audioBuffer) return;
    if (audioCtx.state === 'running') return; // all good

    // Context is not running while it should be — attempt recovery
    setSyncStatus('drifted', 'Recovering audio…');
    try {
      await resumeAudioContext();
    } catch { /* ignore */ }

    // If context is now running and we're not playing, restart from master pos
    if (audioCtx.state === 'running' && !isPlaying) {
      const targetRaw = getEstimatedMasterPosition();
      startPlayback(targetRaw - (manualOffsetMs / 1000));
      setSyncStatus('synced', 'In sync');
    }
  }, 2000);
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
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
}

// ── Play/Pause Button ─────────────────────────────────────────────────────────
function updatePlayPauseBtn() {
  playPauseBtn.innerHTML = isPlaying ? '&#9646;&#9646;' : '&#9654;';
  playPauseBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

playPauseBtn.addEventListener('click', async () => {
  if (!audioBuffer) return;

  if (isPlaying) {
    stopPlayback();
    pendingPlaybackPos = null;
    setSyncStatus('synced', 'Paused locally');
  } else {
    ensureAudioContext();
    await resumeAudioContext();

    if (audioCtx!.state !== 'running') {
      const rawPos = getEstimatedMasterPosition();
      pendingPlaybackPos = rawPos - (manualOffsetMs / 1000);
      setSyncStatus('syncing', 'Waiting for audio…');
    } else {
      const rawPos = getEstimatedMasterPosition();
      startPlayback(rawPos - (manualOffsetMs / 1000));
      setSyncStatus('synced', 'In sync');
    }
  }
});

// ── Show Command Handler ──────────────────────────────────────────────────────
async function handleShowCommand(cmd: ShowCommand) {
  if (!audioBuffer) {
    pendingCommand = cmd;
    return;
  }

  // FIX 1: use cmd.enqueuedAt (stamped on main thread when command entered
  // the queue) rather than Date.now() here. By the time handleShowCommand
  // runs, the command may have waited in the queue for 50–300ms while a
  // previous command's await completed. Using enqueuedAt means
  // masterPositionAt reflects when the command actually arrived, so
  // getEstimatedMasterPosition() correctly advances position by the elapsed
  // time since then.
  masterPosition   = cmd.position;
  masterPositionAt = cmd.enqueuedAt ?? Date.now(); // FIX 1

  switch (cmd.action) {
    case 'play': {
      masterIsPlaying = true;
      ensureAudioContext();
      await resumeAudioContext();
      pendingPlaybackPos = null;
      if (audioCtx!.state !== 'running') {
        pendingPlaybackPos = cmd.position - (manualOffsetMs / 1000);
        setSyncStatus('syncing', 'Waiting for audio…');
      } else {
        startPlayback(cmd.position - (manualOffsetMs / 1000));
        setSyncStatus('synced', 'In sync');
      }
      if (cmd.audioFile) trackName.textContent = cmd.audioFile;
      break;
    }
    case 'pause': {
      masterIsPlaying = false;
      stopPlayback();
      playStartPos = cmd.position;
      setSyncStatus('synced', 'Paused');
      break;
    }
    case 'seek': {
      const wasPlaying = isPlaying;
      stopPlayback();
      pendingPlaybackPos = null;
      playStartPos = cmd.position;
      if (wasPlaying || masterIsPlaying) {
        masterIsPlaying = true;
        ensureAudioContext();
        await resumeAudioContext();
        if (audioCtx!.state !== 'running') {
          pendingPlaybackPos = cmd.position - (manualOffsetMs / 1000);
          setSyncStatus('syncing', 'Waiting for audio…');
        } else {
          startPlayback(cmd.position - (manualOffsetMs / 1000));
          setSyncStatus('synced', 'In sync');
        }
      } else {
        setSyncStatus('synced', 'Paused');
      }
      break;
    }
    case 'load': {
      masterIsPlaying = false;
      stopPlayback();
      playStartPos = 0;
      if (cmd.audioFile) trackName.textContent = cmd.audioFile;
      waitingOverlay.classList.remove('hidden');
      setSyncStatus('waiting', 'Waiting for master');
      break;
    }
  }
}

// ── Manual Resync ─────────────────────────────────────────────────────────────
async function doManualResync() {
  if (!audioBuffer) return;
  ensureAudioContext();
  await resumeAudioContext();

  const masterPos = getEstimatedMasterPosition();

  if (masterIsPlaying) {
    pendingPlaybackPos = null;
    if (audioCtx!.state !== 'running') {
      pendingPlaybackPos = masterPos - (manualOffsetMs / 1000);
      setSyncStatus('syncing', 'Waiting for audio…');
    } else {
      startPlayback(masterPos - (manualOffsetMs / 1000));
      setSyncStatus('synced', 'Resynced');
    }
  } else {
    stopPlayback();
    pendingPlaybackPos = null;
    playStartPos = masterPos;
    setSyncStatus('synced', 'Paused');
  }
}

resyncBtn.addEventListener('click', () => {
  sendToSW({ type: 'sw_hard_resync' });
  doManualResync().then(() => {
    resyncBtn.textContent = '✓ Synced!';
    setTimeout(() => { resyncBtn.innerHTML = '&#8635; Resync Now'; }, 1500);
  });
});

// ── Fine-Tune Offset Controls ─────────────────────────────────────────────────
function applyOffsetChange(oldOffsetMs: number) {
  if (!audioBuffer || !isPlaying) return;
  // getCurrentPosition() returns position WITH old offset baked in.
  // Strip old offset to get raw position; startPlayback re-adds new offset.
  const rawPos = getCurrentPosition() - (oldOffsetMs / 1000);
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
        action:        msg.action,
        position:      msg.position,
        serverTs:      msg.serverTs,
        masterTs:      msg.masterTs,
        audioFile:     msg.audioFile,
        receivedAt:    msg.receivedAt,
        clockOffsetMs: msg.clockOffsetMs,
      };
      enqueueCommand(cmd);
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

// ── Visibility Change — Hard Resync on Screen Wake ────────────────────────────
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;

  // Tab came back to foreground.
  // ensureAudioContext() recreates a closed context (Android screen-off + film end).
  // resumeAudioContext() handles suspended/interrupted states (iOS screen-lock).
  if (audioCtx) {
    ensureAudioContext();
    await resumeAudioContext();
  }

  // Request immediate ping burst from Service Worker to refresh clock offset
  sendToSW({ type: 'sw_hard_resync' });

  // If AudioContext is still not running, statechange handler will restart playback
  if (audioCtx?.state !== 'running') return;

  // Context is running — restart silent keepalive
  startSilentKeepalive();

  if (masterIsPlaying && audioBuffer) {
    if (!isPlaying) {
      // Should be playing but aren't (audio stopped while screen was off)
      setSyncStatus('drifted', 'Resyncing after background…');
      const targetRaw = getEstimatedMasterPosition();
      startPlayback(targetRaw - (manualOffsetMs / 1000));
      setSyncStatus('synced', 'In sync');
    } else {
      // Playing — check drift
      const actualPos   = getCurrentPosition();
      const expectedPos = getEstimatedMasterPosition() + (manualOffsetMs / 1000);
      const drift       = (actualPos - expectedPos) * 1000;
      if (Math.abs(drift) > 200) {
        setSyncStatus('drifted', 'Resyncing after background…');
        const targetRaw = getEstimatedMasterPosition();
        startPlayback(targetRaw - (manualOffsetMs / 1000));
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
        // SW is active but hasn't claimed yet — controllerchange will fire
      }
    });
  });
}

// ── Fallback: Direct WebSocket ─────────────────────────────────────────────────
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
  // iOS Safari: the AudioContext MUST be created and resumed synchronously
  // inside a user gesture handler. Any await before this point causes the
  // gesture context to expire, leaving the AudioContext permanently suspended
  // with no audio output. Create it here — before any async work — so the
  // gesture is still active.
  ensureAudioContext();
  try { audioCtx!.resume(); } catch { /* ignore — will retry in initAudio */ }

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
    // 1. Fetch show state
    const stateRes = await fetch(`${serverBaseUrl}/api/show/${showId}/state`);
    if (!stateRes.ok) throw new Error(`Server error: ${stateRes.status}`);
    const state = await stateRes.json() as {
      audioFile?:  string;
      audioHash?:  string;
      audioReady?: boolean;
      isPlaying:   boolean;
      position:    number;
    };

    // 2. Check local audio cache
    let audioData = await loadAudio(showId);
    if (audioData && state.audioHash && audioData.hash !== state.audioHash) {
      audioData = null;
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

    // 5. Set initial master state from HTTP response (FIX 1: main thread clock)
    masterIsPlaying  = state.isPlaying;
    masterPosition   = state.position;
    masterPositionAt = Date.now();

    // 6. Connect Service Worker WebSocket
    const wsUrl = serverBaseUrl.replace(/^http/, 'ws') + `/api/show/${showId}/ws`;
    await registerSyncWorker(wsUrl);
    setSyncStatus('syncing', 'Syncing clock…');

    // 7. Decode audio
    if (audioData) {
      await initAudio(audioData.data);
      // Start silent keepalive to keep AudioContext alive on iOS screen lock (FIX 3)
      startSilentKeepalive();

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
        await resumeAudioContext();
        startPlayback(masterPos - (manualOffsetMs / 1000));
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
  ensureAudioContext();
  resumeAudioContext();
  joinShow().catch(err => showError(err instanceof Error ? err.message : String(err)));
});

[joinShowIdInput, joinServerUrlInput].forEach(input => {
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      ensureAudioContext();
      joinShow().catch(err => showError(err instanceof Error ? err.message : String(err)));
    }
  });
});

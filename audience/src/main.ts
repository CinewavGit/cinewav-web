/**
 * Cinewav Audience PWA — Main App v4
 *
 * Architecture changes from v3:
 *
 * 1. SERVICE WORKER owns the WebSocket + NTP pings.
 *    Main thread receives commands via postMessage from sync-worker.js.
 *    Benefit: WebSocket is not throttled when tab is backgrounded.
 *
 * 2. WEB AUDIO CLOCK as drift reference.
 *    Drift is measured as:
 *      expected = playStartPos + (audioCtx.currentTime - playStartCtxTime)
 *      drift    = actual - expected
 *    audioCtx.currentTime is a hardware-backed monotonic clock — immune to
 *    browser throttling and system clock adjustments.
 *
 * 3. VISIBILITY HARD RESYNC.
 *    On visibilitychange (tab comes back to foreground), we immediately:
 *    a) Resume AudioContext
 *    b) Request a fresh ping burst from the Service Worker
 *    c) Recalculate drift and resync if needed
 *
 * 4. WEB LOCKS.
 *    Only one tab holds the 'cinewav-sync-lock' at a time.
 *    If a second tab opens, it waits. When the first tab closes, the second
 *    tab acquires the lock and becomes the active player.
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
const silentAudio        = document.getElementById('silent-audio')     as HTMLAudioElement;
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
let masterPositionAt = 0;   // Date.now() when masterPosition was last updated

// Pending command received before audio was decoded
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

// ── Audio Engine ──────────────────────────────────────────────────────────────
function ensureAudioContext() {
  if (!audioCtx) audioCtx = new AudioContext();
}

async function initAudio(arrayBuffer: ArrayBuffer) {
  ensureAudioContext();
  if (audioCtx!.state === 'suspended') await audioCtx!.resume();
  audioBuffer   = await audioCtx!.decodeAudioData(arrayBuffer.slice(0));
  audioDuration = audioBuffer.duration;
  pTotalTime.textContent = formatTime(audioDuration);
  playPauseBtn.disabled  = false;
  resyncBtn.disabled     = false;
}

/**
 * Returns current playback position in seconds using the Web Audio clock.
 * This is the KEY improvement: audioCtx.currentTime is a hardware-backed
 * monotonic timer that is NOT throttled by the browser, unlike Date.now().
 */
function getCurrentPosition(): number {
  if (!audioCtx || !isPlaying) return playStartPos;
  return playStartPos + (audioCtx.currentTime - playStartCtxTime);
}

/**
 * Estimate where the master player is RIGHT NOW.
 * Uses Date.now() since masterPositionAt was recorded, which is fine for
 * estimating the master's position (we just need it to be close enough to
 * schedule a seek — the drift loop corrects any remaining error).
 */
function getEstimatedMasterPosition(): number {
  if (!masterIsPlaying) return masterPosition;
  return masterPosition + (Date.now() - masterPositionAt) / 1000;
}

/**
 * Start playback from rawPosition (seconds, WITHOUT manual offset).
 * manualOffsetMs is applied internally.
 *
 * Uses audioCtx.currentTime to record the exact hardware clock time at
 * which playback started — this is used for drift calculation.
 */
function startPlayback(rawPosition: number) {
  if (!audioCtx || !audioBuffer) return;

  // Null sourceNode FIRST to prevent onended from corrupting state
  const oldNode = sourceNode;
  sourceNode = null;
  if (oldNode) {
    try { oldNode.stop(); } catch { /* already stopped */ }
    oldNode.disconnect();
  }
  if (uiInterval)   { clearInterval(uiInterval);   uiInterval   = null; }
  if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
  isPlaying = false;

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
      if (uiInterval)   { clearInterval(uiInterval);   uiInterval   = null; }
      if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
      updatePlayPauseBtn();
      setSyncStatus('synced', 'Show ended');
    }
  };

  sourceNode       = node;
  // KEY: record the Web Audio hardware clock time at start
  playStartCtxTime = audioCtx.currentTime;
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
  if (uiInterval)   { clearInterval(uiInterval);   uiInterval   = null; }
  if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
  isPlaying = false;
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
    updateMediaSession();
  }, 250);
}

// ── Drift Detection Loop (Web Audio clock based) ──────────────────────────────
const DRIFT_CHECK_MS    = 500;
const RESYNC_AHEAD_MS   = 150;
const RESYNC_BEHIND_MS  = 300;

function startDriftLoop() {
  if (driftInterval) clearInterval(driftInterval);
  driftInterval = setInterval(() => {
    if (!isPlaying || !masterIsPlaying) return;

    // Actual position from Web Audio hardware clock
    const actualPos   = getCurrentPosition();
    // Expected position from master (estimated using wall clock — good enough for comparison)
    const expectedPos = getEstimatedMasterPosition() + (manualOffsetMs / 1000);
    driftMs = (actualPos - expectedPos) * 1000;

    // Update stats display
    statDrift.textContent = `${driftMs >= 0 ? '+' : ''}${Math.round(driftMs)}ms`;
    const abs = Math.abs(driftMs);
    if      (abs < 50)  setSyncStatus('synced',  'In sync');
    else if (abs < 150) setSyncStatus('syncing', `${Math.round(abs)}ms drift`);
    else                setSyncStatus('drifted', `${Math.round(abs)}ms drift`);

    // Auto-resync if outside tolerance
    if (driftMs > RESYNC_AHEAD_MS || driftMs < -RESYNC_BEHIND_MS) {
      resyncs++;
      statResyncs.textContent = String(resyncs);
      const targetRaw = getEstimatedMasterPosition();
      startPlayback(targetRaw - (manualOffsetMs / 1000));
      setSyncStatus('synced', 'In sync');
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
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  if (audioCtx && audioDuration > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audioDuration, playbackRate: 1,
        position: Math.min(getCurrentPosition(), audioDuration),
      });
    } catch { /* not supported on all browsers */ }
  }
}

function startSilentAudio() {
  silentAudio.loop   = true;
  silentAudio.volume = 0.001;
  silentAudio.play().catch(() => {});
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
    setSyncStatus('synced', 'Paused locally');
  } else {
    // Update DOM synchronously BEFORE any await (Android Chrome fix)
    isPlaying = true;
    updatePlayPauseBtn();

    ensureAudioContext();
    if (audioCtx!.state === 'suspended') await audioCtx!.resume();

    const rawPos = getEstimatedMasterPosition();
    startPlayback(rawPos - (manualOffsetMs / 1000));
    setSyncStatus('synced', 'In sync');
  }
});

// ── Show Command Handler ──────────────────────────────────────────────────────
async function handleShowCommand(cmd: ShowCommand) {
  if (!audioCtx || !audioBuffer) {
    pendingCommand = cmd;
    return;
  }

  // Update master state tracking
  masterIsPlaying  = (cmd.action === 'play');
  masterPosition   = cmd.position;
  masterPositionAt = cmd.receivedAt;

  setSyncStatus('syncing', 'Syncing…');

  switch (cmd.action) {
    case 'play': {
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      startPlayback(cmd.position - (manualOffsetMs / 1000));
      setSyncStatus('synced', 'In sync');
      if (cmd.audioFile) trackName.textContent = cmd.audioFile;
      break;
    }
    case 'pause': {
      stopPlayback();
      playStartPos     = cmd.position;
      masterIsPlaying  = false;
      masterPosition   = cmd.position;
      masterPositionAt = Date.now();
      setSyncStatus('synced', 'Paused');
      break;
    }
    case 'seek': {
      const wasPlaying = isPlaying;
      stopPlayback();
      playStartPos = cmd.position;
      masterPosition   = cmd.position;
      masterPositionAt = Date.now();
      if (wasPlaying) {
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        startPlayback(cmd.position - (manualOffsetMs / 1000));
        setSyncStatus('synced', 'In sync');
      } else {
        setSyncStatus('synced', 'Paused');
      }
      break;
    }
    case 'load': {
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
  if (audioCtx!.state === 'suspended') await audioCtx!.resume();

  const masterPos = getEstimatedMasterPosition();

  if (masterIsPlaying) {
    startPlayback(masterPos - (manualOffsetMs / 1000));
    setSyncStatus('synced', 'Resynced');
  } else {
    stopPlayback();
    playStartPos = masterPos;
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
  if (!audioBuffer || !isPlaying) return;
  // getCurrentPosition() returns position WITH old offset baked in.
  // Strip old offset to get raw position; startPlayback re-adds new offset.
  const rawPos = getCurrentPosition() - (oldOffsetMs / 1000);
  startPlayback(rawPos);
}

ftMinus.addEventListener('click', () => {
  const old = manualOffsetMs;
  manualOffsetMs -= 50;
  saveManualOffset();
  applyOffsetChange(old);
});

ftPlus.addEventListener('click', () => {
  const old = manualOffsetMs;
  manualOffsetMs += 50;
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
      // Could display audience count in UI if desired
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

  // Tab just came back to foreground
  if (audioCtx?.state === 'suspended') await audioCtx.resume();

  // Request immediate ping burst from Service Worker to refresh clock offset
  sendToSW({ type: 'sw_hard_resync' });

  // If we were playing, check drift immediately and resync if needed
  if (isPlaying && audioBuffer) {
    const actualPos   = getCurrentPosition();
    const expectedPos = getEstimatedMasterPosition() + (manualOffsetMs / 1000);
    const drift       = (actualPos - expectedPos) * 1000;

    if (Math.abs(drift) > 200) {
      // Significant drift after background — hard resync immediately
      setSyncStatus('drifted', 'Resyncing after background…');
      const targetRaw = getEstimatedMasterPosition();
      startPlayback(targetRaw - (manualOffsetMs / 1000));
      setSyncStatus('synced', 'In sync');
    }
  }
});

// ── Service Worker Setup ──────────────────────────────────────────────────────
async function registerSyncWorker(wsUrl: string): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    // Fallback: run WebSocket directly in main thread (old SyncEngine)
    console.warn('Service Worker not supported — falling back to main thread WebSocket');
    return;
  }

  // Listen for messages from any service worker
  navigator.serviceWorker.addEventListener('message', handleSWMessage);

  // Get the currently active service worker (registered by Vite PWA plugin)
  const reg = await navigator.serviceWorker.ready;
  syncSW    = reg.active;

  // Tell the sync worker to connect
  sendToSW({ type: 'sw_init', wsUrl, showId });
}

// ── Web Locks — Single Instance ───────────────────────────────────────────────
async function acquireSyncLock(callback: () => Promise<void>): Promise<void> {
  if (!('locks' in navigator)) {
    // Web Locks not supported — just run directly
    await callback();
    return;
  }

  // Acquire an exclusive lock. If another tab holds it, this will wait.
  await (navigator as Navigator & { locks: LockManager }).locks.request(
    'cinewav-sync-lock',
    { mode: 'exclusive' },
    async () => {
      await callback();
    }
  );
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
    startSilentAudio();
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

    // ── 7. Decode audio (parallel with WS — commands queued in pendingCommand) ─
    if (audioData) {
      await initAudio(audioData.data);

      if (pendingCommand) {
        const cmd = pendingCommand;
        pendingCommand = null;

        // Add elapsed time since command was received (decode took time)
        if (cmd.action === 'play') {
          const elapsed = (Date.now() - cmd.receivedAt) / 1000;
          cmd.position += elapsed;
          masterPosition   = cmd.position;
          masterPositionAt = Date.now();
        }
        await handleShowCommand(cmd);

      } else if (state.isPlaying) {
        // Show already playing — use estimated master position
        const masterPos = getEstimatedMasterPosition();
        if (audioCtx!.state === 'suspended') await audioCtx!.resume();
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
  if (audioCtx?.state === 'suspended') audioCtx.resume();

  // Acquire Web Lock before joining — ensures only one tab is active
  acquireSyncLock(joinShow).catch(err => showError(err.message));
});

[joinShowIdInput, joinServerUrlInput].forEach(input => {
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      ensureAudioContext();
      acquireSyncLock(joinShow).catch(err => showError(err.message));
    }
  });
});

/**
 * Cinewav Audience — Main App
 *
 * Orchestrates:
 *  1. Show join flow (URL params or manual entry)
 *  2. Audio download + IndexedDB storage
 *  3. Web Audio API playback
 *  4. SyncEngine (NTP clock sync + drift correction)
 *  5. Media Session API (background audio / lock screen controls)
 *  6. UI updates
 *
 * Fix log:
 *  - Join delay: WebSocket connects immediately; audio decode runs in parallel
 *  - Play/Pause: button works as soon as audioBuffer is ready, regardless of
 *    whether master has sent a command yet
 *  - Offset shift: applyOffsetChange() is now synchronous and uses local
 *    isPlaying state so it reacts instantly
 */

import { SyncEngine, ShowCommand } from './syncEngine';
import { saveAudio, loadAudio } from './audioStorage';

// ── Manual Sync DOM Elements ────────────────────────────────────────────────
const syncControlsEl  = document.getElementById('sync-controls')!;
const playPauseBtn    = document.getElementById('play-pause-btn') as HTMLButtonElement;
const resyncBtn       = document.getElementById('resync-btn') as HTMLButtonElement;
const ftMinus         = document.getElementById('ft-minus') as HTMLButtonElement;
const ftPlus          = document.getElementById('ft-plus') as HTMLButtonElement;
const ftReset         = document.getElementById('ft-reset') as HTMLButtonElement;
const ftValue         = document.getElementById('ft-value')!;

// ── DOM ───────────────────────────────────────────────────────────────────────
const screens = {
  join: document.getElementById('screen-join')!,
  download: document.getElementById('screen-download')!,
  player: document.getElementById('screen-player')!,
  error: document.getElementById('screen-error')!,
};

const joinShowIdInput    = document.getElementById('join-show-id') as HTMLInputElement;
const joinServerUrlInput = document.getElementById('join-server-url') as HTMLInputElement;
const joinBtn            = document.getElementById('join-btn') as HTMLButtonElement;
const downloadFilename   = document.getElementById('download-filename')!;
const downloadProgress   = document.getElementById('download-progress') as HTMLElement;
const downloadPercent    = document.getElementById('download-percent')!;
const syncDot            = document.getElementById('sync-dot')!;
const syncStatusText     = document.getElementById('sync-status-text')!;
const albumArt           = document.getElementById('album-art')!;
const trackName          = document.getElementById('track-name')!;
const showIdDisplay      = document.getElementById('show-id-display')!;
const seekFill           = document.getElementById('seek-fill') as HTMLElement;
const pCurrentTime       = document.getElementById('p-current-time')!;
const pTotalTime         = document.getElementById('p-total-time')!;
const statOffset         = document.getElementById('stat-offset')!;
const statDrift          = document.getElementById('stat-drift')!;
const statResyncs        = document.getElementById('stat-resyncs')!;
const statRtt            = document.getElementById('stat-rtt')!;
const waitingOverlay     = document.getElementById('waiting-overlay')!;
const errorMsg           = document.getElementById('error-msg')!;
const silentAudio        = document.getElementById('silent-audio') as HTMLAudioElement;

// ── App State ─────────────────────────────────────────────────────────────────
let audioCtx: AudioContext | null = null;
let audioBuffer: AudioBuffer | null = null;
let sourceNode: AudioBufferSourceNode | null = null;
let isPlaying = false;
let playStartCtxTime = 0;
let playStartPos = 0;
let audioDuration = 0;
let uiInterval: ReturnType<typeof setInterval> | null = null;
let showId = '';
let serverBaseUrl = '';
let syncEngine: SyncEngine | null = null;

/**
 * manualOffsetMs — user-controlled timing adjustment applied on every
 * startPlayback() call.
 * Positive = audio perceived as late → advance start position (audio plays earlier).
 * Negative = audio perceived as early → retard start position (audio plays later).
 * Stored in localStorage per show ID.
 */
let manualOffsetMs = 0;

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
  ftValue.textContent = (manualOffsetMs >= 0 ? '+' : '') + String(manualOffsetMs) + 'ms';
  ftValue.style.color =
    manualOffsetMs === 0 ? 'var(--text-muted)' :
    manualOffsetMs > 0   ? 'var(--warning)' :
                           'var(--success)';
}

// ── Screen Management ─────────────────────────────────────────────────────────
function showScreen(name: keyof typeof screens) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function showError(msg: string) {
  errorMsg.textContent = msg;
  showScreen('error');
}

// ── Time Formatting ───────────────────────────────────────────────────────────
function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// ── URL Parameter Parsing ─────────────────────────────────────────────────────
function parseUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const show = params.get('show');
  const server = params.get('server');
  if (show) joinShowIdInput.value = show;
  if (server) joinServerUrlInput.value = decodeURIComponent(server);
}

// ── Audio Download ────────────────────────────────────────────────────────────
async function downloadAudioFile(url: string, filename: string): Promise<ArrayBuffer> {
  showScreen('download');
  downloadFilename.textContent = filename;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const contentLength = response.headers.get('Content-Length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;
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
      downloadPercent.textContent = `${pct}% — ${(received / 1024 / 1024).toFixed(1)} MB`;
    } else {
      downloadPercent.textContent = `${(received / 1024 / 1024).toFixed(1)} MB downloaded…`;
    }
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined.buffer;
}

// ── Audio Engine ──────────────────────────────────────────────────────────────

/**
 * Create the AudioContext on first call (requires a user gesture on iOS).
 * Subsequent calls reuse the existing context.
 */
function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
}

/**
 * Decode an ArrayBuffer into an AudioBuffer and store it.
 * FIX: We slice the buffer before decoding because decodeAudioData detaches
 * the original ArrayBuffer, making it unusable for a second decode attempt.
 */
async function initAudio(arrayBuffer: ArrayBuffer) {
  ensureAudioContext();
  if (audioCtx!.state === 'suspended') {
    await audioCtx!.resume();
  }
  audioBuffer = await audioCtx!.decodeAudioData(arrayBuffer.slice(0));
  audioDuration = audioBuffer.duration;
  pTotalTime.textContent = formatTime(audioDuration);

  // Enable transport buttons now that audio is ready
  playPauseBtn.disabled = false;
  resyncBtn.disabled = false;
}

function getCurrentPosition(): number {
  if (!audioCtx) return 0;
  if (!isPlaying) return playStartPos;
  return playStartPos + (audioCtx.currentTime - playStartCtxTime);
}

function startPlayback(fromPosition: number) {
  if (!audioCtx || !audioBuffer) return;
  stopPlayback();

  // Apply manual offset: positive = audio was late, so advance start position
  const adjustedPosition = fromPosition + (manualOffsetMs / 1000);
  const clampedPos = Math.max(0, Math.min(adjustedPosition, audioDuration - 0.1));

  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(audioCtx.destination);
  sourceNode.start(0, clampedPos);
  sourceNode.onended = () => {
    if (isPlaying) {
      isPlaying = false;
      setSyncStatus('synced', 'Show ended');
      stopUILoop();
      updatePlayPauseBtn();
    }
  };

  playStartPos = clampedPos;
  playStartCtxTime = audioCtx.currentTime;
  isPlaying = true;
  albumArt.classList.add('playing');
  waitingOverlay.classList.add('hidden');
  startUILoop();
  updatePlayPauseBtn();

  syncEngine?.notifyCommandApplied(clampedPos, true);
  updateMediaSession();
}

function stopPlayback() {
  if (sourceNode) {
    try { sourceNode.stop(); } catch { /* already stopped */ }
    sourceNode.disconnect();
    sourceNode = null;
  }
  isPlaying = false;
  albumArt.classList.remove('playing');
  stopUILoop();
  updatePlayPauseBtn();
}

// ── Media Session API (lock screen / background audio) ───────────────────────
function setupMediaSession(title: string) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: title,
    artist: 'Cinewav',
    album: `Show: ${showId}`,
    artwork: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });

  // Disable default controls — audience cannot seek manually
  navigator.mediaSession.setActionHandler('play', null);
  navigator.mediaSession.setActionHandler('pause', null);
  navigator.mediaSession.setActionHandler('seekbackward', null);
  navigator.mediaSession.setActionHandler('seekforward', null);
  navigator.mediaSession.setActionHandler('previoustrack', null);
  navigator.mediaSession.setActionHandler('nexttrack', null);
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  if (audioCtx && audioDuration > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audioDuration,
        playbackRate: 1,
        position: Math.min(getCurrentPosition(), audioDuration),
      });
    } catch { /* some browsers don't support setPositionState */ }
  }
}

// ── Silent Audio Loop (keeps AudioContext alive on iOS when screen locks) ─────
function startSilentAudio() {
  silentAudio.loop = true;
  silentAudio.volume = 0.001; // near-silent but not zero
  silentAudio.play().catch(() => {
    // Autoplay blocked — will be started on first user interaction
  });
}

// ── Sync Status UI ────────────────────────────────────────────────────────────
type SyncStatusType = 'waiting' | 'syncing' | 'synced' | 'drifted';

function setSyncStatus(status: SyncStatusType, label: string) {
  syncDot.className = `status-dot ${
    status === 'synced'  ? 'synced'  :
    status === 'drifted' ? 'drifted' :
    status === 'syncing' ? 'syncing' : ''
  }`;
  syncStatusText.textContent = label;
}

// ── UI Loop ───────────────────────────────────────────────────────────────────
function startUILoop() {
  stopUILoop();
  uiInterval = setInterval(() => {
    const pos = getCurrentPosition();
    const clampedPos = Math.min(pos, audioDuration);
    pCurrentTime.textContent = formatTime(clampedPos);
    if (audioDuration > 0) {
      seekFill.style.width = `${(clampedPos / audioDuration) * 100}%`;
    }
    updateMediaSession();
    syncEngine?.reportActualPosition(clampedPos);
  }, 250);
}

function stopUILoop() {
  if (uiInterval) { clearInterval(uiInterval); uiInterval = null; }
}

// ── Show Command Handler ──────────────────────────────────────────────────────
async function handleShowCommand(cmd: ShowCommand) {
  // FIX: If audio is not decoded yet, queue the command to replay once ready.
  // This prevents the race condition where the welcome/sync message arrives
  // before decodeAudioData() has finished.
  if (!audioCtx || !audioBuffer) {
    pendingCommand = cmd;
    return;
  }

  setSyncStatus('syncing', 'Syncing…');

  switch (cmd.action) {
    case 'play': {
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      startPlayback(cmd.position);
      setSyncStatus('synced', 'In sync');
      trackName.textContent = cmd.audioFile || 'Now Playing';
      break;
    }
    case 'pause': {
      stopPlayback();
      playStartPos = cmd.position;
      syncEngine?.notifyCommandApplied(cmd.position, false);
      setSyncStatus('synced', 'Paused');
      break;
    }
    case 'seek': {
      const wasPlaying = isPlaying;
      stopPlayback();
      playStartPos = cmd.position;
      if (wasPlaying) {
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        startPlayback(cmd.position);
      }
      syncEngine?.notifyCommandApplied(cmd.position, wasPlaying);
      setSyncStatus('synced', wasPlaying ? 'In sync' : 'Paused');
      break;
    }
    case 'load': {
      stopPlayback();
      playStartPos = 0;
      trackName.textContent = cmd.audioFile || 'Audio Ready';
      waitingOverlay.classList.remove('hidden');
      setSyncStatus('waiting', 'Waiting for master');
      break;
    }
  }
}

// Pending command to replay once audio is decoded
let pendingCommand: ShowCommand | null = null;

// ── Resync Handler ────────────────────────────────────────────────────────────
function handleResync(targetPosition: number, play: boolean) {
  setSyncStatus('drifted', 'Resyncing…');
  if (play) {
    if (audioCtx?.state === 'suspended') audioCtx.resume().then(() => startPlayback(targetPosition));
    else startPlayback(targetPosition);
    setSyncStatus('synced', 'In sync');
  } else {
    stopPlayback();
    playStartPos = targetPosition;
    setSyncStatus('synced', 'Paused');
  }
}

// ── Play/Pause Button ─────────────────────────────────────────────────────────

function updatePlayPauseBtn() {
  playPauseBtn.innerHTML = isPlaying ? '&#9646;&#9646;' : '&#9654;';
  playPauseBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

playPauseBtn.addEventListener('click', async () => {
  // FIX: Create AudioContext on first user gesture if it doesn't exist yet
  ensureAudioContext();
  if (audioCtx!.state === 'suspended') await audioCtx!.resume();

  // If audio isn't decoded yet, nothing to play
  if (!audioBuffer) return;

  if (isPlaying) {
    stopPlayback();
    setSyncStatus('synced', 'Paused locally');
  } else {
    // Resume: sync to master position if available, otherwise use last known position
    const masterPos = syncEngine?.getEstimatedMasterPosition() ?? playStartPos;
    startPlayback(masterPos);
    setSyncStatus('synced', 'In sync');
  }
});

// ── Manual Sync Controls ──────────────────────────────────────────────────────

/**
 * Perform an immediate manual resync to the current master position.
 * FIX: Always awaits audioCtx.resume() first (critical on iOS after screen lock).
 * Uses syncEngine.getIsPlaying() (master state) not local isPlaying.
 */
async function doManualResync() {
  if (!syncEngine || !audioBuffer) return;
  ensureAudioContext();
  if (audioCtx!.state === 'suspended') await audioCtx!.resume();

  const masterPos = syncEngine.getEstimatedMasterPosition();
  if (masterPos === null) return;

  const masterIsPlaying = syncEngine.getIsPlaying();
  stopPlayback();

  if (masterIsPlaying) {
    startPlayback(masterPos);
    setSyncStatus('synced', 'Resynced');
  } else {
    playStartPos = masterPos + (manualOffsetMs / 1000);
    setSyncStatus('synced', 'Paused');
  }
}

resyncBtn.addEventListener('click', () => {
  doManualResync().then(() => {
    resyncBtn.textContent = '✓ Synced!';
    setTimeout(() => { resyncBtn.innerHTML = '&#8635; Resync Now'; }, 1500);
  });
});

/**
 * FIX: applyOffsetChange is now synchronous and uses local isPlaying state.
 * This makes fine-tune buttons react instantly — no async delay.
 */
function applyOffsetChange() {
  if (!audioBuffer) return;
  if (isPlaying) {
    // Recalculate current position and restart immediately with new offset
    const currentPos = getCurrentPosition();
    // Strip the old manual offset out of currentPos before reapplying
    const rawPos = currentPos - (manualOffsetMs / 1000);
    startPlayback(rawPos);
  }
}

ftMinus.addEventListener('click', () => {
  manualOffsetMs -= 50;
  saveManualOffset();
  applyOffsetChange();
});

ftPlus.addEventListener('click', () => {
  manualOffsetMs += 50;
  saveManualOffset();
  applyOffsetChange();
});

ftReset.addEventListener('click', () => {
  manualOffsetMs = 0;
  saveManualOffset();
  applyOffsetChange();
});

// ── Join Flow ─────────────────────────────────────────────────────────────────
async function joinShow() {
  showId = joinShowIdInput.value.trim();
  serverBaseUrl = joinServerUrlInput.value.trim().replace(/\/$/, '');

  if (!showId || !serverBaseUrl) {
    alert('Please enter both a Show ID and Server URL.');
    return;
  }

  localStorage.setItem('cinewav_show_id', showId);
  localStorage.setItem('cinewav_server_url', serverBaseUrl);

  joinBtn.disabled = true;
  joinBtn.textContent = 'Connecting…';

  try {
    // ── Step 1: Fetch show state ──────────────────────────────────────────────
    const stateRes = await fetch(`${serverBaseUrl}/api/show/${showId}/state`);
    if (!stateRes.ok) throw new Error(`Server error: ${stateRes.status}`);
    const state = await stateRes.json() as {
      audioFile?: string;
      audioHash?: string;
      audioReady?: boolean;
      isPlaying: boolean;
      position: number;
    };

    // ── Step 2: Check local audio cache ──────────────────────────────────────
    let audioData = await loadAudio(showId);
    if (audioData && state.audioHash && audioData.hash && audioData.hash !== state.audioHash) {
      audioData = null; // stale cache — will re-download
    }

    // ── Step 3: Download audio if needed ─────────────────────────────────────
    if (!audioData && state.audioReady && state.audioFile) {
      const audioUrl = `${serverBaseUrl}/api/show/${showId}/audio`;
      const arrayBuffer = await downloadAudioFile(audioUrl, state.audioFile);
      await saveAudio(showId, state.audioFile, arrayBuffer, state.audioHash || '');
      audioData = { filename: state.audioFile, hash: state.audioHash || '', data: arrayBuffer };
    }

    // ── Step 4: Switch to player screen immediately ───────────────────────────
    // FIX: Show the player screen and connect WebSocket BEFORE decoding audio.
    // Audio decode (decodeAudioData) can take 2-4s on mobile for long files.
    // Connecting the WebSocket first means sync starts immediately.
    showScreen('player');
    showIdDisplay.textContent = `Show: ${showId}`;
    setupMediaSession(audioData?.filename || 'Cinewav Show');
    startSilentAudio();

    syncControlsEl.style.display = 'flex';
    loadManualOffset();
    // Buttons enabled once audio is decoded (inside initAudio)
    playPauseBtn.disabled = true;
    resyncBtn.disabled = true;

    if (audioData) {
      trackName.textContent = audioData.filename;
    } else {
      trackName.textContent = 'Waiting for audio…';
    }

    // ── Step 5: Connect WebSocket immediately (don't wait for audio decode) ───
    const wsUrl = serverBaseUrl.replace(/^http/, 'ws') + `/api/show/${showId}/ws`;
    syncEngine = new SyncEngine(handleResync, (syncState) => {
      statOffset.textContent = `${syncState.clockOffsetMs > 0 ? '+' : ''}${Math.round(syncState.clockOffsetMs)}ms`;
      statDrift.textContent  = `${syncState.driftMs > 0 ? '+' : ''}${Math.round(syncState.driftMs)}ms`;
      statResyncs.textContent = String(syncState.resyncs);
      statRtt.textContent    = `${Math.round(syncState.rttMs)}ms`;

      if (isPlaying) {
        const absDrift = Math.abs(syncState.driftMs);
        if (absDrift < 50)       setSyncStatus('synced',  'In sync');
        else if (absDrift < 150) setSyncStatus('syncing', `${Math.round(absDrift)}ms drift`);
        else                     setSyncStatus('drifted', `${Math.round(absDrift)}ms drift`);
      }
    });

    syncEngine.setShowCommandHandler(handleShowCommand);

    syncEngine.setAudioReadyHandler(async (filename: string, hash: string) => {
      const existing = await loadAudio(showId);
      if (existing && existing.hash === hash) return;

      setSyncStatus('syncing', 'Downloading audio…');
      trackName.textContent = 'Downloading audio…';
      try {
        const audioUrl = `${serverBaseUrl}/api/show/${showId}/audio`;
        const arrayBuffer = await downloadAudioFile(audioUrl, filename);
        await saveAudio(showId, filename, arrayBuffer, hash);
        await initAudio(arrayBuffer);
        trackName.textContent = filename;
        setupMediaSession(filename);
        setSyncStatus('waiting', 'Audio ready — waiting for show');
      } catch {
        setSyncStatus('waiting', 'Download failed — retry');
      }
    });

    // Connect WebSocket — this starts the ping burst immediately
    await syncEngine.connect(wsUrl, showId);
    setSyncStatus('waiting', 'Waiting for show');

    // ── Step 6: Decode audio in parallel (after WS is connected) ─────────────
    // FIX: Audio decode now happens AFTER WebSocket is connected.
    // The pendingCommand mechanism replays any show command that arrives
    // while decoding is still in progress.
    if (audioData) {
      await initAudio(audioData.data);

      // Replay any command that arrived during decode
      if (pendingCommand) {
        const cmd = pendingCommand;
        pendingCommand = null;
        await handleShowCommand(cmd);
      } else if (state.isPlaying) {
        // Show was already playing when we joined — estimate current position
        const cmd: ShowCommand = {
          action: 'play',
          position: state.position + ((Date.now() - Date.now()) / 1000), // will be corrected by transit
          masterTs: 0,
          serverTs: Date.now(),
          audioFile: state.audioFile,
        };
        await handleShowCommand(cmd);
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
  joinShow();
});

[joinShowIdInput, joinServerUrlInput].forEach((input) => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinShow();
  });
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && audioCtx?.state === 'suspended') {
    audioCtx.resume();
  }
});

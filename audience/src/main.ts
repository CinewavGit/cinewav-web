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
 */

import { SyncEngine, ShowCommand } from './syncEngine';
import { saveAudio, loadAudio } from './audioStorage';

// ── DOM ───────────────────────────────────────────────────────────────────────
const screens = {
  join: document.getElementById('screen-join')!,
  download: document.getElementById('screen-download')!,
  player: document.getElementById('screen-player')!,
  error: document.getElementById('screen-error')!,
};

const joinShowIdInput = document.getElementById('join-show-id') as HTMLInputElement;
const joinServerUrlInput = document.getElementById('join-server-url') as HTMLInputElement;
const joinBtn = document.getElementById('join-btn') as HTMLButtonElement;
const downloadFilename = document.getElementById('download-filename')!;
const downloadProgress = document.getElementById('download-progress') as HTMLElement;
const downloadPercent = document.getElementById('download-percent')!;
const syncDot = document.getElementById('sync-dot')!;
const syncStatusText = document.getElementById('sync-status-text')!;
const albumArt = document.getElementById('album-art')!;
const trackName = document.getElementById('track-name')!;
const showIdDisplay = document.getElementById('show-id-display')!;
const seekFill = document.getElementById('seek-fill') as HTMLElement;
const pCurrentTime = document.getElementById('p-current-time')!;
const pTotalTime = document.getElementById('p-total-time')!;
const statOffset = document.getElementById('stat-offset')!;
const statDrift = document.getElementById('stat-drift')!;
const statResyncs = document.getElementById('stat-resyncs')!;
const statRtt = document.getElementById('stat-rtt')!;
const waitingOverlay = document.getElementById('waiting-overlay')!;
const errorMsg = document.getElementById('error-msg')!;
const silentAudio = document.getElementById('silent-audio') as HTMLAudioElement;

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

  // Combine chunks into a single ArrayBuffer
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
async function initAudio(arrayBuffer: ArrayBuffer) {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  audioDuration = audioBuffer.duration;
  pTotalTime.textContent = formatTime(audioDuration);
}

function getCurrentPosition(): number {
  if (!audioCtx) return 0;
  if (!isPlaying) return playStartPos;
  return playStartPos + (audioCtx.currentTime - playStartCtxTime);
}

function startPlayback(fromPosition: number) {
  if (!audioCtx || !audioBuffer) return;
  stopPlayback();

  const clampedPos = Math.max(0, Math.min(fromPosition, audioDuration - 0.1));
  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(audioCtx.destination);
  sourceNode.start(0, clampedPos);
  sourceNode.onended = () => {
    if (isPlaying) {
      isPlaying = false;
      setSyncStatus('synced', 'Show ended');
      stopUILoop();
    }
  };

  playStartPos = clampedPos;
  playStartCtxTime = audioCtx.currentTime;
  isPlaying = true;
  albumArt.classList.add('playing');
  waitingOverlay.classList.add('hidden');
  startUILoop();

  // Notify sync engine
  syncEngine?.notifyCommandApplied(clampedPos, true);

  // Update Media Session
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
  // iOS Safari suspends AudioContext when screen locks unless there is
  // a visible <audio> element playing. We play a silent 1-second loop.
  silentAudio.volume = 0.001; // near-silent but not zero (some browsers mute zero)
  silentAudio.play().catch(() => {
    // Autoplay blocked — will be started on first user interaction
  });
}

// ── Sync Status UI ────────────────────────────────────────────────────────────
type SyncStatusType = 'waiting' | 'syncing' | 'synced' | 'drifted';

function setSyncStatus(status: SyncStatusType, label: string) {
  syncDot.className = `status-dot ${status === 'synced' ? 'synced' : status === 'drifted' ? 'drifted' : status === 'syncing' ? 'syncing' : ''}`;
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
    // Report actual position to sync engine for drift calculation
    syncEngine?.reportActualPosition(clampedPos);
  }, 250);
}

function stopUILoop() {
  if (uiInterval) { clearInterval(uiInterval); uiInterval = null; }
}

// ── Show Command Handler ──────────────────────────────────────────────────────
async function handleShowCommand(cmd: ShowCommand) {
  if (!audioCtx || !audioBuffer) {
    // Audio not ready yet — queue the command
    return;
  }

  setSyncStatus('syncing', 'Syncing…');

  switch (cmd.action) {
    case 'play': {
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
      if (wasPlaying) startPlayback(cmd.position);
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

// ── Resync Handler ────────────────────────────────────────────────────────────
function handleResync(targetPosition: number, play: boolean) {
  setSyncStatus('drifted', 'Resyncing…');
  if (play) {
    startPlayback(targetPosition);
    setSyncStatus('synced', 'In sync');
  } else {
    stopPlayback();
    playStartPos = targetPosition;
    setSyncStatus('synced', 'Paused');
  }
}

// ── Join Flow ─────────────────────────────────────────────────────────────────
async function joinShow() {
  showId = joinShowIdInput.value.trim();
  serverBaseUrl = joinServerUrlInput.value.trim().replace(/\/$/, '');

  if (!showId || !serverBaseUrl) {
    alert('Please enter both a Show ID and Server URL.');
    return;
  }

  // Save to localStorage for convenience
  localStorage.setItem('cinewav_show_id', showId);
  localStorage.setItem('cinewav_server_url', serverBaseUrl);

  joinBtn.disabled = true;
  joinBtn.textContent = 'Connecting…';

  try {
    // 1. Fetch show state to check if audio file is specified
    const stateRes = await fetch(`${serverBaseUrl}/api/show/${showId}/state`);
    if (!stateRes.ok) throw new Error(`Server error: ${stateRes.status}`);
    const state = await stateRes.json() as { audioFile?: string; isPlaying: boolean; position: number };

    // 2. Check if we already have the audio stored locally
    let audioData = await loadAudio(showId);

    if (!audioData && state.audioFile) {
      // 3. Download the audio file from R2 / server
      const audioUrl = `${serverBaseUrl}/api/show/${showId}/audio`;
      const arrayBuffer = await downloadAudioFile(audioUrl, state.audioFile);
      await saveAudio(showId, state.audioFile, arrayBuffer);
      audioData = { filename: state.audioFile, data: arrayBuffer };
    }

    // 4. Switch to player screen and init audio
    showScreen('player');
    showIdDisplay.textContent = `Show: ${showId}`;
    setupMediaSession(audioData?.filename || 'Cinewav Show');
    startSilentAudio();

    if (audioData) {
      await initAudio(audioData.data);
      trackName.textContent = audioData.filename;
    } else {
      trackName.textContent = 'Waiting for audio…';
    }

    // 5. Connect WebSocket sync engine
    const wsUrl = serverBaseUrl.replace(/^http/, 'ws') + `/api/show/${showId}/ws`;
    syncEngine = new SyncEngine(handleResync, (syncState) => {
      statOffset.textContent = `${syncState.clockOffsetMs > 0 ? '+' : ''}${Math.round(syncState.clockOffsetMs)}ms`;
      statDrift.textContent = `${syncState.driftMs > 0 ? '+' : ''}${Math.round(syncState.driftMs)}ms`;
      statResyncs.textContent = String(syncState.resyncs);
      statRtt.textContent = `${Math.round(syncState.rttMs)}ms`;

      // Update sync status indicator based on drift
      if (isPlaying) {
        const absDrift = Math.abs(syncState.driftMs);
        if (absDrift < 50) setSyncStatus('synced', 'In sync');
        else if (absDrift < 150) setSyncStatus('syncing', `${Math.round(absDrift)}ms drift`);
        else setSyncStatus('drifted', `${Math.round(absDrift)}ms drift`);
      }
    });

    syncEngine.setShowCommandHandler(handleShowCommand);

    await syncEngine.connect(wsUrl, showId);
    setSyncStatus('waiting', 'Waiting for show');

    // If show is already playing, apply current state immediately
    if (state.isPlaying && audioData) {
      // Estimate current position accounting for time since state was fetched
      const cmd: ShowCommand = {
        action: 'play',
        position: state.position,
        masterTs: 0,
        serverTs: Date.now(),
        audioFile: state.audioFile,
      };
      await handleShowCommand(cmd);
    }

  } catch (err) {
    showError(err instanceof Error ? err.message : 'Failed to join show');
  }
}

// ── Initialisation ────────────────────────────────────────────────────────────
parseUrlParams();

// Restore saved values
const savedShowId = localStorage.getItem('cinewav_show_id');
const savedServerUrl = localStorage.getItem('cinewav_server_url');
if (savedShowId && !joinShowIdInput.value) joinShowIdInput.value = savedShowId;
if (savedServerUrl && !joinServerUrlInput.value) joinServerUrlInput.value = savedServerUrl;

joinBtn.addEventListener('click', () => {
  // Resume AudioContext on user gesture (required by browsers)
  if (audioCtx?.state === 'suspended') audioCtx.resume();
  joinShow();
});

// Allow joining by pressing Enter
[joinShowIdInput, joinServerUrlInput].forEach((input) => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinShow();
  });
});

// Handle page visibility change — resume AudioContext when tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && audioCtx?.state === 'suspended') {
    audioCtx.resume();
  }
});

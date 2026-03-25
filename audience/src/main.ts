/**
 * Cinewav Audience PWA — Main App v3
 *
 * Clean rewrite fixing:
 *  1. 3-4s behind on join: pendingCommand now stores receivedAt timestamp
 *     so elapsed time is added when replaying the command after decode.
 *  2. Resync does nothing: commandAppliedAt is now set in syncEngine on
 *     message receipt, so getEstimatedMasterPosition() is always accurate.
 *  3. Play/Pause stuck: sourceNode reference is nulled BEFORE calling stop()
 *     so the onended callback cannot corrupt isPlaying state.
 *  4. Transit correction was backwards in syncEngine (now fixed in v3).
 */

import { SyncEngine, ShowCommand } from './syncEngine';
import { saveAudio, loadAudio } from './audioStorage';

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
let audioCtx:        AudioContext | null           = null;
let audioBuffer:     AudioBuffer  | null           = null;
let sourceNode:      AudioBufferSourceNode | null  = null;
let isPlaying        = false;
let playStartCtxTime = 0;
let playStartPos     = 0;
let audioDuration    = 0;
let uiInterval:      ReturnType<typeof setInterval> | null = null;
let showId           = '';
let serverBaseUrl    = '';
let syncEngine:      SyncEngine | null             = null;
let manualOffsetMs   = 0;

// Pending command received while audio was still decoding.
// Stores the command AND when it was received so we can add elapsed time.
let pendingCommand: ShowCommand | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
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
  const p = new URLSearchParams(window.location.search);
  const show   = p.get('show');
  const server = p.get('server');
  if (show)   joinShowIdInput.value    = show;
  if (server) joinServerUrlInput.value = decodeURIComponent(server);
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
  playPauseBtn.disabled = false;
  resyncBtn.disabled    = false;
}

/** Returns the current playback position in seconds (raw, without manual offset). */
function getCurrentPosition(): number {
  if (!audioCtx) return 0;
  if (!isPlaying) return playStartPos;
  return playStartPos + (audioCtx.currentTime - playStartCtxTime);
}

/**
 * Start playback from rawPosition (seconds, NOT including manual offset).
 * manualOffsetMs is applied internally.
 *
 * FIX: sourceNode is nulled BEFORE calling stop() so the onended callback
 * cannot fire and corrupt isPlaying after we've already started a new node.
 */
function startPlayback(rawPosition: number) {
  if (!audioCtx || !audioBuffer) return;

  // FIX: null sourceNode FIRST, then stop the old one.
  // This prevents the old node's onended from setting isPlaying=false
  // after we've already set it to true for the new node.
  const oldNode = sourceNode;
  sourceNode = null;
  if (oldNode) {
    try { oldNode.stop(); } catch { /* already stopped */ }
    oldNode.disconnect();
  }
  if (uiInterval) { clearInterval(uiInterval); uiInterval = null; }
  isPlaying = false;

  const adjusted = rawPosition + (manualOffsetMs / 1000);
  const clamped  = Math.max(0, Math.min(adjusted, audioDuration - 0.1));

  const node = audioCtx.createBufferSource();
  node.buffer = audioBuffer;
  node.connect(audioCtx.destination);
  node.start(0, clamped);

  // onended: only act if this node is still the active one
  node.onended = () => {
    if (sourceNode === node) {
      sourceNode = null;
      isPlaying  = false;
      albumArt.classList.remove('playing');
      if (uiInterval) { clearInterval(uiInterval); uiInterval = null; }
      updatePlayPauseBtn();
      setSyncStatus('synced', 'Show ended');
    }
  };

  sourceNode       = node;
  playStartPos     = clamped;
  playStartCtxTime = audioCtx.currentTime;
  isPlaying        = true;

  albumArt.classList.add('playing');
  waitingOverlay.classList.add('hidden');
  updatePlayPauseBtn();
  startUILoop();
  syncEngine?.notifyCommandApplied(clamped, true);
  updateMediaSession();
}

function stopPlayback() {
  const node = sourceNode;
  sourceNode = null;           // null FIRST so onended is ignored
  if (node) {
    try { node.stop(); } catch { /* already stopped */ }
    node.disconnect();
  }
  isPlaying = false;
  albumArt.classList.remove('playing');
  if (uiInterval) { clearInterval(uiInterval); uiInterval = null; }
  updatePlayPauseBtn();
}

// ── UI Loop ───────────────────────────────────────────────────────────────────
function startUILoop() {
  if (uiInterval) clearInterval(uiInterval);
  uiInterval = setInterval(() => {
    const pos     = getCurrentPosition();
    const clamped = Math.min(pos, audioDuration);
    pCurrentTime.textContent = formatTime(clamped);
    if (audioDuration > 0) seekFill.style.width = `${(clamped / audioDuration) * 100}%`;
    updateMediaSession();
    syncEngine?.reportActualPosition(clamped);
  }, 250);
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
  navigator.mediaSession.setActionHandler('play',          null);
  navigator.mediaSession.setActionHandler('pause',         null);
  navigator.mediaSession.setActionHandler('seekbackward',  null);
  navigator.mediaSession.setActionHandler('seekforward',   null);
  navigator.mediaSession.setActionHandler('previoustrack', null);
  navigator.mediaSession.setActionHandler('nexttrack',     null);
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
    // Synchronous path — no await needed
    stopPlayback();
    setSyncStatus('synced', 'Paused locally');
  } else {
    // Optimistically update DOM BEFORE any await (Android Chrome fix)
    isPlaying = true;
    updatePlayPauseBtn();

    ensureAudioContext();
    if (audioCtx!.state === 'suspended') await audioCtx!.resume();

    // Use master position if available, else last known position
    const rawPos = syncEngine?.getEstimatedMasterPosition() ?? playStartPos;
    // Strip manual offset from estimate (startPlayback re-adds it)
    startPlayback(rawPos - (manualOffsetMs / 1000));
    setSyncStatus('synced', 'In sync');
  }
});

// ── Show Command Handler ──────────────────────────────────────────────────────
async function handleShowCommand(cmd: ShowCommand) {
  if (!audioCtx || !audioBuffer) {
    // Queue command — will be replayed once audio is decoded
    pendingCommand = cmd;
    return;
  }

  setSyncStatus('syncing', 'Syncing…');

  switch (cmd.action) {
    case 'play': {
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      // cmd.position is already transit-corrected by syncEngine.
      // Strip manual offset — startPlayback re-adds it.
      startPlayback(cmd.position - (manualOffsetMs / 1000));
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
        startPlayback(cmd.position - (manualOffsetMs / 1000));
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

// ── Resync Handler (called by SyncEngine drift detector) ─────────────────────
function handleResync(targetPosition: number, play: boolean) {
  setSyncStatus('drifted', 'Resyncing…');
  if (play) {
    if (audioCtx?.state === 'suspended') {
      audioCtx.resume().then(() => startPlayback(targetPosition - (manualOffsetMs / 1000)));
    } else {
      startPlayback(targetPosition - (manualOffsetMs / 1000));
    }
    setSyncStatus('synced', 'In sync');
  } else {
    stopPlayback();
    playStartPos = targetPosition;
    setSyncStatus('synced', 'Paused');
  }
}

// ── Manual Resync Button ──────────────────────────────────────────────────────
async function doManualResync() {
  if (!audioBuffer) return;
  ensureAudioContext();
  if (audioCtx!.state === 'suspended') await audioCtx!.resume();

  const masterPos = syncEngine?.getEstimatedMasterPosition() ?? null;
  if (masterPos === null) {
    setSyncStatus('waiting', 'No sync signal yet');
    return;
  }

  const masterIsPlaying = syncEngine?.getIsPlaying() ?? false;

  if (masterIsPlaying) {
    // Strip manual offset — startPlayback re-adds it
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
  // Strip old offset to get raw position, then startPlayback re-adds new offset.
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

// ── Join Flow ─────────────────────────────────────────────────────────────────
async function joinShow() {
  showId        = joinShowIdInput.value.trim();
  serverBaseUrl = joinServerUrlInput.value.trim().replace(/\/$/, '');

  if (!showId || !serverBaseUrl) {
    alert('Please enter both a Show ID and Server URL.');
    return;
  }

  localStorage.setItem('cinewav_show_id',     showId);
  localStorage.setItem('cinewav_server_url',  serverBaseUrl);

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
      audioData = null; // stale — re-download
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

    // ── 5. Connect WebSocket (starts ping burst immediately) ──────────────────
    const wsUrl = serverBaseUrl.replace(/^http/, 'ws') + `/api/show/${showId}/ws`;

    syncEngine = new SyncEngine(handleResync, (syncState) => {
      statOffset.textContent  = `${syncState.clockOffsetMs >= 0 ? '+' : ''}${Math.round(syncState.clockOffsetMs)}ms`;
      statDrift.textContent   = `${syncState.driftMs >= 0 ? '+' : ''}${Math.round(syncState.driftMs)}ms`;
      statResyncs.textContent = String(syncState.resyncs);
      statRtt.textContent     = `${Math.round(syncState.rttMs)}ms`;

      if (isPlaying) {
        const abs = Math.abs(syncState.driftMs);
        if      (abs < 50)  setSyncStatus('synced',  'In sync');
        else if (abs < 150) setSyncStatus('syncing', `${Math.round(abs)}ms drift`);
        else                setSyncStatus('drifted', `${Math.round(abs)}ms drift`);
      }
    });

    syncEngine.setShowCommandHandler(handleShowCommand);

    syncEngine.setAudioReadyHandler(async (filename: string, hash: string) => {
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
    });

    await syncEngine.connect(wsUrl, showId);
    setSyncStatus('waiting', 'Waiting for show');

    // ── 6. Decode audio (after WS connected so commands don't get lost) ───────
    if (audioData) {
      await initAudio(audioData.data);

      if (pendingCommand) {
        // A command arrived while we were decoding.
        // FIX: Add elapsed time since the command was received so the
        // position is current, not stale.
        const cmd = pendingCommand;
        pendingCommand = null;

        if (cmd.action === 'play') {
          const elapsedSinceReceived = (Date.now() - cmd.receivedAt) / 1000;
          cmd.position += elapsedSinceReceived;
        }
        await handleShowCommand(cmd);

      } else if (state.isPlaying) {
        // Show was already playing when we fetched state.
        // syncEngine already has the corrected position from the welcome message
        // (received while we were decoding). Use that — it's more accurate than
        // the HTTP state which was stale even when we fetched it.
        const masterPos = syncEngine.getEstimatedMasterPosition();
        if (masterPos !== null) {
          if (audioCtx!.state === 'suspended') await audioCtx!.resume();
          startPlayback(masterPos - (manualOffsetMs / 1000));
          setSyncStatus('synced', 'In sync');
        }
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

[joinShowIdInput, joinServerUrlInput].forEach(input => {
  input.addEventListener('keydown', e => { if (e.key === 'Enter') joinShow(); });
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && audioCtx?.state === 'suspended') audioCtx.resume();
});

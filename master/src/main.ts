/**
 * Cinewav Master — Video-Driven Sync Controller
 *
 * Architecture:
 *  - The HTML5 <video> element is the master clock.
 *  - video.currentTime is the single source of truth for position.
 *  - Play / pause / seek events on the video are captured and
 *    broadcast to all audience devices via WebSocket.
 *  - The operator loads a video file (MP4, MOV, WebM, etc.).
 *  - The audio track extracted from that same video is what the
 *    audience downloads and plays on their devices.
 */

import QRCode from 'qrcode';

// ── DOM Elements ─────────────────────────────────────────────────────────────
// Audio upload elements
const audioDropZone       = document.getElementById('audio-drop-zone')!;
const audioFileHidden     = (() => { const i = document.createElement('input'); i.type = 'file'; i.accept = 'audio/*'; return i; })();
const uploadProgressWrap  = document.getElementById('upload-progress-wrap')!;
const uploadFilenameEl    = document.getElementById('upload-filename')!;
const uploadPercentEl     = document.getElementById('upload-percent')!;
const uploadBarFill       = document.getElementById('upload-bar-fill') as HTMLElement;
const audioReadyBadge     = document.getElementById('audio-ready-badge')!;
const audioReadyName      = document.getElementById('audio-ready-name')!;
const replaceAudioBtn     = document.getElementById('replace-audio-btn') as HTMLButtonElement;

const wsStatusEl        = document.getElementById('ws-status')!;
const wsDotEl           = document.getElementById('ws-dot')!;
const audienceCountEl   = document.getElementById('audience-count-header')!;
const showIdInput       = document.getElementById('show-id') as HTMLInputElement;
const workerUrlInput    = document.getElementById('worker-url') as HTMLInputElement;
const connectBtn        = document.getElementById('connect-btn') as HTMLButtonElement;
const videoPanel        = document.getElementById('video-panel')!;
const videoDropZone     = document.getElementById('video-drop-zone')!;
const videoPlayer       = document.getElementById('video-player') as HTMLVideoElement;
const videoFilenameEl   = document.getElementById('video-filename')!;
const changeVideoBtn    = document.getElementById('change-video-btn') as HTMLButtonElement;
const videoFileInput    = document.getElementById('video-file-input') as HTMLInputElement;
const playPauseBtn      = document.getElementById('play-pause-btn') as HTMLButtonElement;
const seekBar           = document.getElementById('seek-bar') as HTMLInputElement;
const currentTimeEl     = document.getElementById('current-time')!;
const totalTimeEl       = document.getElementById('total-time')!;
const resyncBtn         = document.getElementById('resync-btn') as HTMLButtonElement;
const fullscreenBtn     = document.getElementById('fullscreen-btn') as HTMLButtonElement;
const statListeners     = document.getElementById('stat-listeners')!;
const statPosition      = document.getElementById('stat-position')!;
const statLatency       = document.getElementById('stat-latency')!;
const statState         = document.getElementById('stat-state')!;
const audienceUrlEl     = document.getElementById('audience-url')!;
const copyUrlBtn        = document.getElementById('copy-url-btn') as HTMLButtonElement;
const qrPlaceholder     = document.getElementById('qr-placeholder')!;
const qrCanvasWrap      = document.getElementById('qr-canvas-wrap')!;
const qrCanvas          = document.getElementById('qr-canvas') as HTMLCanvasElement;
const qrDownloadBtn     = document.getElementById('qr-download-btn') as HTMLButtonElement;
const qrCopyImgBtn      = document.getElementById('qr-copy-img-btn') as HTMLButtonElement;
const logEl             = document.getElementById('log')!;

// ── State ─────────────────────────────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let serverLatencyMs = 0;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let uiInterval: ReturnType<typeof setInterval> | null = null;
let currentShowId = '';
let currentWorkerBase = '';
let isSeeking = false;
let videoObjectUrl = '';
let broadcastThrottle: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg: string, level: 'info' | 'success' | 'warn' | 'error' = 'info') {
  const ts = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.textContent = `[${ts}] ${msg}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
  while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild!);
}

// ── Time Formatting ───────────────────────────────────────────────────────────
function formatTime(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function setWsStatus(status: 'connecting' | 'connected' | 'disconnected' | 'error') {
  const labels = {
    connecting: 'Connecting…',
    connected: 'Connected',
    disconnected: 'Disconnected',
    error: 'Error',
  };
  wsStatusEl.textContent = labels[status];
  wsDotEl.className = `status-dot ${
    status === 'connected' ? 'connected' :
    status === 'connecting' ? 'connecting' :
    status === 'error' ? 'error' : ''
  }`;
}

function connectWebSocket() {
  const showId = showIdInput.value.trim() || 'demo';
  const workerBase = workerUrlInput.value.trim();

  if (!workerBase) {
    log('Please enter the Sync Server URL', 'error');
    return;
  }

  currentShowId = showId;
  currentWorkerBase = workerBase.replace(/^http/, 'ws').replace(/\/$/, '');
  const wsUrl = `${currentWorkerBase}/api/show/${showId}/ws`;

  // Detach handlers before closing so the old socket's onclose doesn't
  // schedule a second auto-reconnect on top of the one already in progress.
  if (ws) {
    ws.onopen    = null;
    ws.onmessage = null;
    ws.onerror   = null;
    ws.onclose   = null;
    ws.close();
    ws = null;
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  setWsStatus('connecting');
  log(`Connecting to ${wsUrl}…`);
  connectBtn.disabled = true;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setWsStatus('connected');
    log('WebSocket connected', 'success');
    connectBtn.textContent = 'Reconnect';
    connectBtn.disabled = false;

    ws!.send(JSON.stringify({ type: 'join', role: 'master', clientId: `master-${Date.now()}` }));
    startPingLoop();

    // Build audience URL
    const httpBase = workerBase.replace(/^ws/, 'http').replace(/\/$/, '');
    const audienceUrl = `https://cinewav-audience.pages.dev?show=${showId}&server=${encodeURIComponent(httpBase)}`;
    audienceUrlEl.textContent = audienceUrl;
    copyUrlBtn.disabled = false;
    generateQR(audienceUrl, showId);

    // If video is already loaded, broadcast its current state so audience
    // devices that were already connected get the correct play/pause position
    // after a master WS reconnect (e.g. after a Cloudflare DO restart).
    if (videoPlayer.readyState >= 1) {
      broadcastLoad();
      // Re-broadcast current play/pause state so devices don't get stuck
      // in 'waiting' after a reconnect when the show is already in progress.
      setTimeout(() => {
        if (videoPlayer.paused) {
          broadcastPause(videoPlayer.currentTime);
        } else {
          broadcastPlay(videoPlayer.currentTime);
        }
      }, 200);
      updateTransportEnabled(true);
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch {
      log('Received invalid JSON from server', 'warn');
    }
  };

  ws.onclose = () => {
    setWsStatus('disconnected');
    log('WebSocket disconnected — reconnecting in 3s…', 'warn');
    connectBtn.disabled = false;
    stopPingLoop();
    // Auto-reconnect so a DO crash during rapid seeks doesn't leave the
    // master permanently offline. Guard with reconnectTimer so only one
    // reconnect attempt is ever scheduled at a time.
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      log('Auto-reconnecting…', 'info');
      connectWebSocket();
    }, 3000);
  };

  ws.onerror = () => {
    setWsStatus('error');
    log('WebSocket error', 'error');
    connectBtn.disabled = false;
  };
}

function handleServerMessage(msg: Record<string, unknown>) {
  switch (msg.type) {
    case 'pong': {
      const clientTs = msg.clientTs as number;
      const now = Date.now();
      const rtt = now - clientTs;
      serverLatencyMs = rtt / 2;
      statLatency.textContent = `${Math.round(serverLatencyMs)}ms`;
      break;
    }
    case 'audience_count': {
      const count = msg.count as number;
      statListeners.textContent = String(count);
      audienceCountEl.textContent = `${count} listener${count !== 1 ? 's' : ''}`;
      break;
    }
    case 'error': {
      log(`Server error: ${msg.message}`, 'error');
      break;
    }
  }
}

// ── NTP Ping Loop ─────────────────────────────────────────────────────────────
function startPingLoop() {
  stopPingLoop();
  pingInterval = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping', clientId: 'master', clientTs: Date.now() }));
    }
  }, 5000);
}

function stopPingLoop() {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
}

// ── Broadcast Helpers ─────────────────────────────────────────────────────────
function send(payload: object) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastLoad() {
  const name = videoFilenameEl.textContent || 'show';
  send({
    type: 'command',
    action: 'load',
    position: 0,
    masterTs: Date.now(),
    audioFile: name,
  });
  log(`Broadcast: LOAD "${name}"`, 'success');
}

function broadcastPlay(position?: number) {
  const pos = position ?? videoPlayer.currentTime;
  send({
    type: 'command',
    action: 'play',
    position: pos,
    masterTs: Date.now(),
  });
  log(`Broadcast: PLAY @ ${formatTime(pos)}`, 'success');
}

function broadcastPause(position?: number) {
  const pos = position ?? videoPlayer.currentTime;
  send({
    type: 'command',
    action: 'pause',
    position: pos,
    masterTs: Date.now(),
  });
  log(`Broadcast: PAUSE @ ${formatTime(pos)}`, 'success');
}

function broadcastSeek(position: number, isPlaying: boolean) {
  send({
    type: 'command',
    action: isPlaying ? 'play' : 'seek',
    position,
    masterTs: Date.now(),
  });
  log(`Broadcast: SEEK to ${formatTime(position)}`, 'success');
}

// ── Video File Loading ────────────────────────────────────────────────────────
function loadVideoFile(file: File) {
  // Revoke previous object URL to free memory
  if (videoObjectUrl) {
    URL.revokeObjectURL(videoObjectUrl);
  }

  videoObjectUrl = URL.createObjectURL(file);
  videoPlayer.src = videoObjectUrl;
  videoPlayer.load();

  // Strip extension for display name
  const displayName = file.name.replace(/\.[^.]+$/, '');
  videoFilenameEl.textContent = displayName;

  log(`Loading video: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`);
}

// ── Video Event Handlers ──────────────────────────────────────────────────────
videoPlayer.addEventListener('loadedmetadata', () => {
  const dur = videoPlayer.duration;
  seekBar.max = String(dur);
  seekBar.value = '0';
  totalTimeEl.textContent = formatTime(dur);
  currentTimeEl.textContent = formatTime(0);

  videoPanel.classList.add('has-video');
  updateTransportEnabled(ws?.readyState === WebSocket.OPEN);

  log(`Video ready: ${formatTime(dur)} duration`, 'success');

  // Broadcast load to audience if connected
  if (ws?.readyState === WebSocket.OPEN) {
    broadcastLoad();
  }
});

videoPlayer.addEventListener('play', () => {
  playPauseBtn.textContent = '⏸';
  playPauseBtn.className = 'play-btn pause';
  statState.textContent = 'PLAYING';
  startUILoop();

  // Throttle broadcasts to avoid double-firing on seek+play
  if (broadcastThrottle) clearTimeout(broadcastThrottle);
  broadcastThrottle = setTimeout(() => {
    broadcastPlay();
    broadcastThrottle = null;
  }, 50);
});

videoPlayer.addEventListener('pause', () => {
  playPauseBtn.textContent = '▶';
  playPauseBtn.className = 'play-btn play';
  statState.textContent = videoPlayer.ended ? 'ENDED' : 'PAUSED';
  stopUILoop();
  updateUI();
  // CRITICAL: cancel any pending broadcastPlay throttle before broadcasting pause.
  // The 'play' event handler queues broadcastPlay() on a 50ms timer to avoid
  // double-firing on seek+play sequences. If the user presses Pause within that
  // 50ms window, the pending broadcastPlay fires AFTER broadcastPause, overriding
  // it on the server and restarting all audience devices.
  if (broadcastThrottle) { clearTimeout(broadcastThrottle); broadcastThrottle = null; }
  if (!isSeeking) {
    broadcastPause();
  }
});

videoPlayer.addEventListener('seeked', () => {
  // Always broadcast after a seek — whether triggered by the seek bar
  // (isSeeking was true) or programmatically (isSeeking was false).
  // Clear isSeeking here so the 'pause' event that fires during seeking
  // is correctly suppressed until the seek completes.
  isSeeking = false;
  // Cancel any pending broadcastPlay from the 'play' event that fires
  // after seek — seeked already sends the correct position.
  if (broadcastThrottle) { clearTimeout(broadcastThrottle); broadcastThrottle = null; }
  broadcastSeek(videoPlayer.currentTime, !videoPlayer.paused);
  updateUI();
});

videoPlayer.addEventListener('ended', () => {
  statState.textContent = 'ENDED';
  stopUILoop();
  broadcastPause(videoPlayer.duration);
});

// ── Transport Controls ────────────────────────────────────────────────────────
function updateTransportEnabled(enabled: boolean) {
  playPauseBtn.disabled = !enabled;
  seekBar.disabled = !enabled;
  resyncBtn.disabled = !enabled;
}

playPauseBtn.addEventListener('click', () => {
  if (videoPlayer.paused) {
    videoPlayer.play();
  } else {
    videoPlayer.pause();
  }
});

seekBar.addEventListener('mousedown', () => { isSeeking = true; });
seekBar.addEventListener('touchstart', () => { isSeeking = true; }, { passive: true });

seekBar.addEventListener('input', () => {
  currentTimeEl.textContent = formatTime(Number(seekBar.value));
});

seekBar.addEventListener('change', () => {
  const pos = Number(seekBar.value);
  // Keep isSeeking = true until the 'seeked' event fires.
  // If we clear it here, the browser's intermediate 'pause' event
  // (fired while seeking) will see isSeeking=false and broadcast a
  // spurious PAUSE that stops all audience devices.
  videoPlayer.currentTime = pos;
  // broadcastSeek is handled in the 'seeked' handler below.
});

resyncBtn.addEventListener('click', () => {
  const pos = videoPlayer.currentTime;
  const action = videoPlayer.paused ? 'pause' : 'play';
  send({
    type: 'command',
    action,
    position: pos,
    masterTs: Date.now(),
  });
  log(`Force resync: ${action.toUpperCase()} @ ${formatTime(pos)}`, 'warn');
});

// ── Fullscreen ────────────────────────────────────────────────────────────────
fullscreenBtn.addEventListener('click', toggleFullscreen);

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
    fullscreenBtn.textContent = '⛶ Full';
  } else {
    videoPanel.requestFullscreen().then(() => {
      fullscreenBtn.textContent = '✕ Exit';
    }).catch(() => {
      // Try video element directly as fallback
      videoPlayer.requestFullscreen?.();
    });
  }
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) {
    fullscreenBtn.textContent = '⛶ Full';
  }
});

// Keyboard shortcut: Space = play/pause, F = fullscreen
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (videoPlayer.readyState >= 1) {
      videoPlayer.paused ? videoPlayer.play() : videoPlayer.pause();
    }
  }
  if (e.code === 'KeyF') {
    toggleFullscreen();
  }
});

// ── UI Update Loop ────────────────────────────────────────────────────────────
function startUILoop() {
  stopUILoop();
  uiInterval = setInterval(updateUI, 250);
}

function stopUILoop() {
  if (uiInterval) { clearInterval(uiInterval); uiInterval = null; }
}

function updateUI() {
  if (videoPlayer.readyState < 1) return;
  const pos = videoPlayer.currentTime;
  if (!isSeeking) {
    seekBar.value = String(pos);
    currentTimeEl.textContent = formatTime(pos);
  }
  statPosition.textContent = formatTime(pos);
}

// ── Video File Drop / Click ───────────────────────────────────────────────────
videoDropZone.addEventListener('click', () => videoFileInput.click());
changeVideoBtn.addEventListener('click', () => videoFileInput.click());

videoFileInput.addEventListener('change', () => {
  const file = videoFileInput.files?.[0];
  if (file) loadVideoFile(file);
});

// Drag and drop onto the video panel
videoPanel.addEventListener('dragover', (e) => {
  e.preventDefault();
  videoPanel.classList.add('drag-active');
  videoDropZone.classList.add('drag-over');
});

videoPanel.addEventListener('dragleave', () => {
  videoPanel.classList.remove('drag-active');
  videoDropZone.classList.remove('drag-over');
});

videoPanel.addEventListener('drop', (e) => {
  e.preventDefault();
  videoPanel.classList.remove('drag-active');
  videoDropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file && (file.type.startsWith('video/') || file.type.startsWith('audio/'))) {
    loadVideoFile(file);
  } else if (file) {
    log('Please drop a video or audio file', 'warn');
  }
});

// ── Copy Audience URL ─────────────────────────────────────────────────────────
copyUrlBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(audienceUrlEl.textContent || '').then(() => {
    copyUrlBtn.textContent = 'Copied!';
    setTimeout(() => { copyUrlBtn.textContent = 'Copy Audience Link'; }, 2000);
  });
});

// ── Connect Button ───────────────────────────────────────────────────────────
connectBtn.addEventListener('click', connectWebSocket);

// Also connect when pressing Enter in either input field
showIdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectWebSocket(); });
workerUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectWebSocket(); });

// ── Persist Worker URL ────────────────────────────────────────────────────────
const savedUrl = localStorage.getItem('cinewav_worker_url');
if (savedUrl) workerUrlInput.value = savedUrl;
workerUrlInput.addEventListener('change', () => {
  localStorage.setItem('cinewav_worker_url', workerUrlInput.value);
});

// ── Audio Upload ─────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hash of the file content for cache-busting on the audience side.
 *
 * The old approach (size + lastModified) was not unique enough: two audio files
 * exported from the same project with the same duration and codec settings often
 * produce identical size values, and lastModified is only second-precision on some
 * systems. This caused the audience device to see a hash match and skip the download
 * even when the audio content had changed.
 *
 * SHA-256 via SubtleCrypto is cryptographically unique — any byte difference in the
 * file content produces a completely different hash. It runs entirely in the browser
 * (no server round-trip) and takes ~200ms for a 38 MB file on a modern device.
 */
async function fileFingerprint(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function uploadAudioFile(file: File) {
  if (!currentWorkerBase) {
    log('Connect to the sync server first before uploading audio', 'warn');
    return;
  }
  if (!currentShowId) {
    log('Enter a Show ID before uploading audio', 'warn');
    return;
  }

  const filename = file.name;
  const uploadUrl = `${currentWorkerBase.replace(/^ws/, 'http')}/api/show/${currentShowId}/audio`;

  // Show progress UI
  audioDropZone.style.display = 'none';
  uploadProgressWrap.classList.add('visible');
  audioReadyBadge.classList.remove('visible');
  uploadFilenameEl.textContent = filename;
  uploadPercentEl.textContent = '0%';
  uploadBarFill.style.width = '0%';

  // Compute SHA-256 hash before upload — this takes ~200ms for a 38 MB file.
  // Show a brief 'Hashing…' status so the user knows the UI is not frozen.
  log(`Hashing audio: ${filename} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`);
  uploadPercentEl.textContent = 'Hashing…';
  const hash = await fileFingerprint(file);
  uploadPercentEl.textContent = '0%';

  log(`Uploading audio: ${filename} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`);

  try {
    // Use XMLHttpRequest for upload progress events
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('X-Audio-Filename', filename);
      xhr.setRequestHeader('X-Audio-Hash', hash);
      xhr.setRequestHeader('Content-Type', file.type || 'audio/mpeg');

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          uploadBarFill.style.width = `${pct}%`;
          uploadPercentEl.textContent = `${pct}%`;
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed: HTTP ${xhr.status} — ${xhr.responseText}`));
        }
      };

      xhr.onerror = () => reject(new Error('Upload failed: network error'));
      xhr.send(file);
    });

    // Upload complete — show badge
    uploadProgressWrap.classList.remove('visible');
    audioReadyBadge.classList.add('visible');
    audioReadyName.textContent = filename;
    log(`Audio uploaded: "${filename}" — audience will download automatically`, 'success');

  } catch (err) {
    uploadProgressWrap.classList.remove('visible');
    audioDropZone.style.display = '';
    log(`Audio upload failed: ${err}`, 'error');
  }
}

// Audio drop zone interactions
audioDropZone.addEventListener('click', () => audioFileHidden.click());
replaceAudioBtn.addEventListener('click', () => {
  audioReadyBadge.classList.remove('visible');
  audioDropZone.style.display = '';
  audioFileHidden.click();
});

audioFileHidden.addEventListener('change', () => {
  const file = audioFileHidden.files?.[0];
  if (file) uploadAudioFile(file);
});

audioDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  audioDropZone.classList.add('drag-over');
});
audioDropZone.addEventListener('dragleave', () => audioDropZone.classList.remove('drag-over'));
audioDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  audioDropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files?.[0];
  if (file && file.type.startsWith('audio/')) {
    uploadAudioFile(file);
  } else if (file) {
    log('Please drop an audio file (MP3, AAC, WAV, M4A)', 'warn');
  }
});

// ── QR Code ───────────────────────────────────────────────────────────────────
async function generateQR(url: string, showId: string) {
  try {
    await QRCode.toCanvas(qrCanvas, url, {
      width: 200,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
    qrPlaceholder.style.display = 'none';
    qrCanvasWrap.classList.add('visible');
    log('QR code generated', 'success');
  } catch (err) {
    log(`QR generation failed: ${err}`, 'warn');
  }
}

qrDownloadBtn.addEventListener('click', () => {
  const url = qrCanvas.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = `cinewav-qr-${(document.getElementById('show-id') as HTMLInputElement).value.trim() || 'show'}.png`;
  a.click();
  log('QR code downloaded as PNG', 'success');
});

qrCopyImgBtn.addEventListener('click', async () => {
  try {
    const blob = await new Promise<Blob>((resolve, reject) =>
      qrCanvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')))
    );
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob })
    ]);
    qrCopyImgBtn.textContent = '✓ Copied!';
    setTimeout(() => { qrCopyImgBtn.textContent = '⎘ Copy Image'; }, 2000);
    log('QR code copied to clipboard', 'success');
  } catch {
    log('Copy to clipboard not supported in this browser', 'warn');
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
log('Cinewav Master ready. Drop a video file and connect to your sync server.', 'info');

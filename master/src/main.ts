/**
 * Cinewav Master — Main Controller
 *
 * Responsibilities:
 *  1. Connect to the Cloudflare Worker via WebSocket
 *  2. Load an audio file and play it locally via Web Audio API
 *  3. Send play/pause/seek commands to all audience devices
 *  4. Measure server latency (NTP ping/pong)
 *  5. Draw a waveform visualizer
 */

// ── DOM Elements ─────────────────────────────────────────────────────────────
const wsStatusEl = document.getElementById('ws-status')!;
const wsDotEl = document.getElementById('ws-dot')!;
const audienceCountHeaderEl = document.getElementById('audience-count-header')!;
const showIdInput = document.getElementById('show-id') as HTMLInputElement;
const workerUrlInput = document.getElementById('worker-url') as HTMLInputElement;
const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const audioFileInput = document.getElementById('audio-file') as HTMLInputElement;
const audioNameInput = document.getElementById('audio-name') as HTMLInputElement;
const loadBtn = document.getElementById('load-btn') as HTMLButtonElement;
const playPauseBtn = document.getElementById('play-pause-btn') as HTMLButtonElement;
const seekBar = document.getElementById('seek-bar') as HTMLInputElement;
const currentTimeEl = document.getElementById('current-time')!;
const totalTimeEl = document.getElementById('total-time')!;
const resyncBtn = document.getElementById('resync-btn') as HTMLButtonElement;
const statListeners = document.getElementById('stat-listeners')!;
const statPosition = document.getElementById('stat-position')!;
const statLatency = document.getElementById('stat-latency')!;
const statState = document.getElementById('stat-state')!;
const audienceUrlEl = document.getElementById('audience-url')!;
const copyUrlBtn = document.getElementById('copy-url-btn') as HTMLButtonElement;
const logEl = document.getElementById('log')!;
const waveformCanvas = document.getElementById('waveform') as HTMLCanvasElement;

// ── State ─────────────────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let audioCtx: AudioContext | null = null;
let audioBuffer: AudioBuffer | null = null;
let sourceNode: AudioBufferSourceNode | null = null;
let analyserNode: AnalyserNode | null = null;
let isPlaying = false;
let playStartTime = 0;    // audioCtx.currentTime when play started
let playStartPos = 0;     // audio position (seconds) when play started
let audioDuration = 0;
let serverLatencyMs = 0;
let pingInterval: ReturnType<typeof setInterval> | null = null;
let uiInterval: ReturnType<typeof setInterval> | null = null;
let animFrameId: number | null = null;
let currentShowId = '';
let currentWorkerBase = '';
let isSeeking = false;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg: string, level: 'info' | 'success' | 'warn' | 'error' = 'info') {
  const ts = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  entry.textContent = `[${ts}] ${msg}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
  // Keep log to last 200 entries
  while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild!);
}

// ── Time Formatting ───────────────────────────────────────────────────────────
function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// ── WebSocket Connection ──────────────────────────────────────────────────────
function setWsStatus(status: 'connecting' | 'connected' | 'disconnected' | 'error') {
  const labels = { connecting: 'Connecting…', connected: 'Connected', disconnected: 'Disconnected', error: 'Error' };
  wsStatusEl.textContent = labels[status];
  wsDotEl.className = `status-dot ${status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : status === 'error' ? 'error' : ''}`;
}

function connectWebSocket() {
  const showId = showIdInput.value.trim() || 'demo';
  const workerBase = workerUrlInput.value.trim();

  if (!workerBase) {
    log('Please enter the Sync Server URL', 'error');
    return;
  }

  currentShowId = showId;
  // Convert http(s) to ws(s) if needed
  currentWorkerBase = workerBase.replace(/^http/, 'ws').replace(/\/$/, '');
  const wsUrl = `${currentWorkerBase}/api/show/${showId}/ws`;

  if (ws) { ws.close(); ws = null; }

  setWsStatus('connecting');
  log(`Connecting to ${wsUrl}…`);
  connectBtn.disabled = true;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setWsStatus('connected');
    log('WebSocket connected', 'success');
    connectBtn.textContent = 'Reconnect';
    connectBtn.disabled = false;
    loadBtn.disabled = false;

    // Join as master
    ws!.send(JSON.stringify({ type: 'join', role: 'master', clientId: `master-${Date.now()}` }));

    // Start NTP ping loop
    startPingLoop();

    // Update audience link
    const httpBase = workerBase.replace(/^ws/, 'http').replace(/\/$/, '');
    const audienceUrl = `${window.location.origin.replace('5173', '5174')}?show=${showId}&server=${encodeURIComponent(httpBase)}`;
    audienceUrlEl.textContent = audienceUrl;
    copyUrlBtn.disabled = false;

    // Enable controls if audio is loaded
    if (audioBuffer) {
      playPauseBtn.disabled = false;
      seekBar.disabled = false;
      resyncBtn.disabled = false;
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
    log('WebSocket disconnected', 'warn');
    connectBtn.disabled = false;
    stopPingLoop();
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
      const serverTs = msg.serverTs as number;
      const now = Date.now();
      const rtt = now - clientTs;
      serverLatencyMs = rtt / 2;
      statLatency.textContent = `${Math.round(serverLatencyMs)}ms`;
      // Optionally: compute clock offset = serverTs - (clientTs + rtt/2)
      break;
    }
    case 'welcome':
    case 'state': {
      log(`Show state received: ${msg.isPlaying ? 'playing' : 'paused'} @ ${formatTime(msg.position as number)}`, 'info');
      break;
    }
    case 'audience_count': {
      const count = msg.count as number;
      statListeners.textContent = String(count);
      audienceCountHeaderEl.textContent = `${count} listener${count !== 1 ? 's' : ''}`;
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

// ── Audio Loading ─────────────────────────────────────────────────────────────
async function loadAudio(file: File) {
  log(`Loading audio: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)…`);
  loadBtn.disabled = true;

  try {
    if (!audioCtx) {
      audioCtx = new AudioContext();
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.connect(audioCtx.destination);
    }

    const arrayBuffer = await file.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    audioDuration = audioBuffer.duration;

    seekBar.max = String(audioDuration);
    seekBar.value = '0';
    totalTimeEl.textContent = formatTime(audioDuration);
    currentTimeEl.textContent = '0:00';

    if (!audioNameInput.value) {
      audioNameInput.value = file.name.replace(/\.[^.]+$/, '');
    }

    log(`Audio loaded: ${formatTime(audioDuration)} duration`, 'success');

    // Draw static waveform
    drawWaveform(audioBuffer);

    // Broadcast load command to audience
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'command',
        action: 'load',
        position: 0,
        masterTs: audioCtx.currentTime,
        audioFile: audioNameInput.value,
      }));
      log('Broadcast: audio loaded to audience', 'success');
    }

    if (ws?.readyState === WebSocket.OPEN) {
      playPauseBtn.disabled = false;
      seekBar.disabled = false;
      resyncBtn.disabled = false;
    }

    loadBtn.disabled = false;
  } catch (err) {
    log(`Failed to load audio: ${err}`, 'error');
    loadBtn.disabled = false;
  }
}

// ── Waveform Drawing ──────────────────────────────────────────────────────────
function drawWaveform(buffer: AudioBuffer) {
  const ctx = waveformCanvas.getContext('2d')!;
  const W = waveformCanvas.offsetWidth || 800;
  const H = 60;
  waveformCanvas.width = W;
  waveformCanvas.height = H;

  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / W);
  const amp = H / 2;

  ctx.fillStyle = '#1c1c28';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#6c63ff';
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let i = 0; i < W; i++) {
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) {
      const v = data[i * step + j] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.moveTo(i, amp + min * amp);
    ctx.lineTo(i, amp + max * amp);
  }
  ctx.stroke();
}

// ── Playback Controls ─────────────────────────────────────────────────────────
function getCurrentAudioPosition(): number {
  if (!audioCtx) return 0;
  if (!isPlaying) return playStartPos;
  return playStartPos + (audioCtx.currentTime - playStartTime);
}

function startPlayback(fromPosition: number) {
  if (!audioCtx || !audioBuffer || !analyserNode) return;
  stopPlayback();

  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(analyserNode);
  sourceNode.start(0, fromPosition);
  sourceNode.onended = () => {
    if (isPlaying) {
      isPlaying = false;
      playPauseBtn.textContent = '▶';
      playPauseBtn.className = 'play-btn play';
      statState.textContent = 'ENDED';
    }
  };

  playStartPos = fromPosition;
  playStartTime = audioCtx.currentTime;
  isPlaying = true;
  playPauseBtn.textContent = '⏸';
  playPauseBtn.className = 'play-btn pause';
  statState.textContent = 'PLAYING';
  startUILoop();
}

function stopPlayback() {
  if (sourceNode) {
    try { sourceNode.stop(); } catch { /* already stopped */ }
    sourceNode.disconnect();
    sourceNode = null;
  }
}

function togglePlayPause() {
  if (!audioCtx || !audioBuffer) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const position = getCurrentAudioPosition();

  if (isPlaying) {
    // Pause
    stopPlayback();
    playStartPos = position;
    isPlaying = false;
    playPauseBtn.textContent = '▶';
    playPauseBtn.className = 'play-btn play';
    statState.textContent = 'PAUSED';
    stopUILoop();

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'command',
        action: 'pause',
        position,
        masterTs: audioCtx.currentTime,
      }));
      log(`Broadcast: PAUSE @ ${formatTime(position)}`, 'success');
    }
  } else {
    // Play
    startPlayback(position);

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'command',
        action: 'play',
        position,
        masterTs: audioCtx.currentTime,
      }));
      log(`Broadcast: PLAY @ ${formatTime(position)}`, 'success');
    }
  }
}

function seekTo(position: number) {
  if (!audioCtx || !audioBuffer) return;
  const wasPlaying = isPlaying;

  if (isPlaying) stopPlayback();
  playStartPos = position;
  isPlaying = false;

  if (wasPlaying) {
    startPlayback(position);
  }

  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'command',
      action: wasPlaying ? 'play' : 'seek',
      position,
      masterTs: audioCtx.currentTime,
    }));
    log(`Broadcast: SEEK to ${formatTime(position)}`, 'success');
  }
}

function forceResync() {
  if (!audioCtx || !ws || ws.readyState !== WebSocket.OPEN) return;
  const position = getCurrentAudioPosition();
  const action = isPlaying ? 'play' : 'pause';
  ws.send(JSON.stringify({
    type: 'command',
    action,
    position,
    masterTs: audioCtx.currentTime,
  }));
  log(`Force resync: ${action.toUpperCase()} @ ${formatTime(position)}`, 'warn');
}

// ── UI Update Loop ────────────────────────────────────────────────────────────
function startUILoop() {
  stopUILoop();
  uiInterval = setInterval(updateUI, 250);
}

function stopUILoop() {
  if (uiInterval) { clearInterval(uiInterval); uiInterval = null; }
}

function updateUI() {
  if (!audioBuffer) return;
  const pos = getCurrentAudioPosition();
  const clampedPos = Math.min(pos, audioDuration);
  if (!isSeeking) {
    seekBar.value = String(clampedPos);
    currentTimeEl.textContent = formatTime(clampedPos);
  }
  statPosition.textContent = formatTime(clampedPos);
}

// ── Event Listeners ───────────────────────────────────────────────────────────
connectBtn.addEventListener('click', connectWebSocket);

loadBtn.addEventListener('click', () => {
  if (audioFileInput.files?.[0]) {
    loadAudio(audioFileInput.files[0]);
  } else {
    log('Please select an audio file first', 'warn');
  }
});

audioFileInput.addEventListener('change', () => {
  if (audioFileInput.files?.[0]) {
    loadAudio(audioFileInput.files[0]);
  }
});

playPauseBtn.addEventListener('click', togglePlayPause);

seekBar.addEventListener('mousedown', () => { isSeeking = true; });
seekBar.addEventListener('touchstart', () => { isSeeking = true; });
seekBar.addEventListener('input', () => {
  currentTimeEl.textContent = formatTime(Number(seekBar.value));
});
seekBar.addEventListener('change', () => {
  isSeeking = false;
  seekTo(Number(seekBar.value));
});

resyncBtn.addEventListener('click', forceResync);

copyUrlBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(audienceUrlEl.textContent || '').then(() => {
    copyUrlBtn.textContent = 'Copied!';
    setTimeout(() => { copyUrlBtn.textContent = 'Copy Link'; }, 2000);
  });
});

// Auto-fill worker URL from localStorage
const savedUrl = localStorage.getItem('cinewav_worker_url');
if (savedUrl) workerUrlInput.value = savedUrl;
workerUrlInput.addEventListener('change', () => {
  localStorage.setItem('cinewav_worker_url', workerUrlInput.value);
});

log('Cinewav Master ready. Enter your Show ID and Sync Server URL to begin.', 'info');

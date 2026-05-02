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
const redownloadBtn      = document.getElementById('redownload-btn')   as HTMLButtonElement;
const ftMinus            = document.getElementById('ft-minus')         as HTMLButtonElement;
const ftPlus             = document.getElementById('ft-plus')          as HTMLButtonElement;
const ftReset            = document.getElementById('ft-reset')         as HTMLButtonElement;
const ftValue            = document.getElementById('ft-value')!;

// ── App State ─────────────────────────────────────────────────────────────────
let audioCtx:        AudioContext | null          = null;
// Primary playback engine: HTMLAudioElement + createMediaElementSource.
// Replaces AudioBufferSourceNode to avoid decoding the entire file into RAM
// (a 2-hour stereo 44.1 kHz file = ~1.3 GB PCM — exceeds iOS Safari's limit).
// The browser streams the MP3 from a Blob URL, decoding only what it needs.
let audioElement:    HTMLAudioElement | null       = null;
let audioBlobUrl:    string | null                 = null;  // revoked on new load
let audioMediaSource: MediaElementAudioSourceNode | null = null; // Web Audio graph node
let keepaliveNode:   AudioBufferSourceNode | null = null; // FIX 3: silent keepalive (iOS)
let androidKeepalive: HTMLAudioElement | null = null;        // Android AudioManager keepalive
let androidKeepaliveSource: MediaElementAudioSourceNode | null = null; // createMediaElementSource bridge
let isPlaying         = false;
let playStartWallTime = 0;  // Date.now() when playback started (wall clock, not audio clock)
let playStartPos      = 0;  // audio position (seconds) when playback started
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

// WebSocket connection state — true only when the SW has an open connection.
// All playback that depends on server position is gated behind this flag.
// When false, the play button and resync button are disabled and show
// "Reconnecting…" so the user cannot start independent playback.
let swConnected = false;

// Pending command received before audio was decoded
let pendingCommand: ShowCommand | null = null;

// Pending playback start deferred until AudioContext resumes
let pendingPlaybackPos: number | null = null;

// audioBuffer is no longer used (replaced by HTMLAudioElement streaming).
// Kept as null so any legacy references compile without error.
let audioBuffer: AudioBuffer | null = null;  // @deprecated — not used
let rawAudioData: ArrayBuffer | null = null; // @deprecated — not used

// Platform output latency in ms (non-zero on Android with latencyHint:'playback').
// Measured from audioCtx.outputLatency + audioCtx.baseLatency after context creation.
// Subtracted from the wall-clock position in startPlayback to compensate for
// the OS audio buffer delay so audio aligns with the master timeline.
let platformLatencyMs = 0;

// FIX 2: consecutive out-of-range drift readings required before auto-resync
let driftOutOfRangeCount = 0;
const DRIFT_CONFIRM_COUNT = 2;

// Service Worker reference
let syncSW: ServiceWorker | null = null;

// Guard flag: true while an automatic re-download triggered by a hash mismatch
// is in progress. Prevents multiple concurrent re-downloads from being started
// by rapid sw_command messages that all carry the new audioHash.
let isRedownloading = false;

// Hash of the audio file currently loaded in memory.
// Updated whenever audio is downloaded or loaded from IndexedDB.
// Used in the sw_command handler to detect a new file without reading
// IndexedDB on every message (which is slow on Android and caused a
// 20–30 second startup delay).
let currentAudioHash = '';

// WebSocket URL for the current show — stored at join time so handleScreenWake
// can re-register the SW pipeline after a long screen-off kill without a reload.
let currentWsUrl: string | null = null;

// ── Serial Command Queue ──────────────────────────────────────────────────────
// Commands are processed synchronously one at a time.
// This prevents rapid seek+play sequences from corrupting shared state.
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
  try { handleShowCommand(cmd); } catch { /* ignore */ }
  drainCommandQueue();
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

// ── Syncing Timeout ─────────────────────────────────────────────────────────
// If the UI stays in 'syncing' state for more than 6 seconds without a
// sw_command arriving (e.g. the welcome message was lost due to a race in the
// SW), automatically send another sw_hard_resync to break the stuck state.
// This is the belt-and-suspenders fix for the 'permanent flashing syncing dot'
// bug on Android after a connection loss.
let syncingTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
function startSyncingTimeout() {
  if (syncingTimeoutTimer) clearTimeout(syncingTimeoutTimer);
  syncingTimeoutTimer = setTimeout(() => {
    syncingTimeoutTimer = null;
    // Only retry if still stuck in syncing — if a command arrived it would
    // have set the status to 'synced' or 'waiting', clearing this state.
    const currentText = syncStatusText.textContent || '';
    if (currentText.includes('Syncing') || currentText.includes('Starting audio')) {
      console.warn('[Cinewav] Stuck in syncing state — forcing resync');
      if (currentWsUrl && (!swConnected || !navigator.serviceWorker?.controller)) {
        syncSW = null;
        registerSyncWorker(currentWsUrl).catch(() => {});
      } else {
        sendToSW({ type: 'sw_hard_resync' });
      }
      // Restart the timeout so we keep retrying every 6s until resolved.
      startSyncingTimeout();
    }
  }, 6000);
}
function clearSyncingTimeout() {
  if (syncingTimeoutTimer) {
    clearTimeout(syncingTimeoutTimer);
    syncingTimeoutTimer = null;
  }
}

type SyncStatusType = 'waiting' | 'syncing' | 'synced' | 'drifted';
function setSyncStatus(status: SyncStatusType, label: string) {
  syncDot.className = `status-dot ${
    status === 'synced'  ? 'synced'  :
    status === 'drifted' ? 'drifted' :
    status === 'syncing' ? 'syncing' : ''
  }`;
  syncStatusText.textContent = label;
  // Clear the syncing timeout whenever we reach a resolved state.
  // This prevents the auto-retry from firing after the device has already synced.
  if (status === 'synced' || status === 'waiting') {
    clearSyncingTimeout();
  }
}

function setConnectionState(connected: boolean) {
  swConnected = connected;
  if (!connected) {
    // Disable interactive controls so the user cannot start independent playback
    playPauseBtn.disabled  = true;
    resyncBtn.disabled     = true;
    redownloadBtn.disabled = true;
    setSyncStatus('waiting', 'Reconnecting…');
  } else {
    // Re-enable controls only if audio is loaded
    if (audioBuffer) {
      playPauseBtn.disabled  = false;
      resyncBtn.disabled     = false;
      redownloadBtn.disabled = false;
    }
    // Always request a fresh authoritative state on reconnect.
    // Do NOT use stale local masterIsPlaying/masterPosition — they may be
    // completely wrong after a long pause or missed commands.
    sendToSW({ type: 'sw_hard_resync' });
    // Start the syncing timeout so we auto-retry if the sw_command is lost.
    startSyncingTimeout();
  }
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
  } else if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage(msg);
  }
}

// ── Audio Download ────────────────────────────────────────────────────────────
async function downloadAudioFile(url: string, filename: string): Promise<ArrayBuffer> {
  showScreen('download');
  downloadFilename.textContent = filename;

  // Bypass ALL cache layers — browser HTTP cache, Service Worker fetch interception,
  // and Cloudflare edge cache — so a re-download always fetches the current file
  // from R2 rather than a stale cached copy.
  //
  // Three mechanisms used together:
  //  1. cache: 'no-store'  — tells the browser not to read from or write to its
  //     HTTP cache for this request. This also prevents the SW fetch handler
  //     from serving a cached response via event.respondWith(fetch(request))
  //     because the underlying fetch itself bypasses the cache.
  //  2. ?_cb=<timestamp>  — cache-busting query parameter that makes the URL
  //     unique on every download, defeating any URL-keyed cache (CDN, SW cache
  //     storage, browser disk cache) that ignores Cache-Control headers.
  //  3. Cache-Control: no-cache header on the R2 response is also changed to
  //     'no-store' (see worker/src/index.ts) so Cloudflare's edge does not
  //     serve a stale copy to subsequent requests.
  const bustUrl = `${url}?_cb=${Date.now()}`;
  const response = await fetch(bustUrl, { cache: 'no-store' });
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
      // Context just resumed — only honour a pendingPlaybackPos that was
      // explicitly set by a command handler or the play button in THIS session.
      // Do NOT blindly restart based on masterIsPlaying: that flag may be stale
      // (e.g. master paused while context was suspended on Android, but the
      // pause command was missed). Using a stale masterIsPlaying=true here is
      // the root cause of the ghost-play bug on Android.
      // The health-check timer and visibility-change handler will request a
      // fresh resync from the server to get the authoritative current state.
      if (pendingPlaybackPos !== null) {
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
    if (keepaliveNode) {
      try { keepaliveNode.stop(); } catch { /* already stopped */ }
      keepaliveNode = null;
    }
    stopAndroidKeepalive();
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

    // Android fix D: use latencyHint 'playback' when creating the AudioContext.
    // This tells Android Chrome to treat this as a long-form media playback
    // session (like a music player) rather than an interactive app. It uses
    // larger audio buffers and prevents the OS from aggressively suspending
    // the context after repeated stop/start cycles during rapid seeks.
    // Reference: https://github.com/carlosrafaelgn/FPlayWeb — the only known
    // Web Audio player that reliably survives Android screen-off + seek cycles.
    audioCtx = new AudioContext({ latencyHint: 'playback' });
    attachAudioContextListeners(audioCtx);

    // Measure the total output latency introduced by the OS audio stack.
    // On Android with latencyHint:'playback', Chrome requests a large buffer
    // (~300ms) which causes audio to play late relative to the wall clock.
    // outputLatency = time from when audio is submitted to when it reaches speakers.
    // baseLatency   = time for a single render quantum to be processed.
    // We store this and subtract it from the seek offset in startPlayback so
    // the audio aligns with the master timeline despite the buffering delay.
    // iOS does not use latencyHint:'playback' (it uses audioSession.type instead)
    // so outputLatency is near-zero there and this correction is a no-op.
    // NOTE: outputLatency is NOT read here — it returns 0 while the context is
    // still suspended (i.e. immediately after creation). It is read inside
    // startPlayback() after the context has been resumed and is running.
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
    // HTMLAudioElement streaming: no re-decode needed.
    // The audioElement Blob URL persists across AudioContext recreation.
    // Re-connect the mediaSource node to the new context.
    if (audioElement && audioCtx && audioCtx.state !== 'closed') {
      try {
        // Disconnect old mediaSource if it exists (from previous context)
        if (audioMediaSource) {
          try { audioMediaSource.disconnect(); } catch { /* already disconnected */ }
          audioMediaSource = null;
        }
        const mediaSource = audioCtx.createMediaElementSource(audioElement);
        mediaSource.connect(audioCtx.destination);
        audioMediaSource = mediaSource;
      } catch (e) {
        console.warn('[Cinewav] Failed to reconnect audioElement to new context:', e);
      }
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

  // ── HTMLAudioElement streaming (replaces decodeAudioData) ───────────────────────
  // Revoke previous Blob URL to free memory before creating a new one.
  if (audioBlobUrl) {
    URL.revokeObjectURL(audioBlobUrl);
    audioBlobUrl = null;
  }
  // Disconnect previous mediaSource node if it exists.
  if (audioMediaSource) {
    try { audioMediaSource.disconnect(); } catch { /* already disconnected */ }
    audioMediaSource = null;
  }

  // Create a Blob URL from the ArrayBuffer. The browser streams the MP3 from
  // this URL, decoding only the frames it needs — no 1.3 GB PCM allocation.
  const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
  audioBlobUrl = URL.createObjectURL(blob);

  // Create or reuse the HTMLAudioElement.
  if (!audioElement) {
    audioElement = new Audio();
    audioElement.crossOrigin = 'anonymous';
    audioElement.preload = 'metadata'; // load duration without buffering entire file
    audioElement.playsInline = true;
  } else {
    audioElement.pause();
  }
  audioElement.src = audioBlobUrl;

  // Wait for metadata (duration) to be available.
  await new Promise<void>((resolve) => {
    if (audioElement!.readyState >= 1) { resolve(); return; }
    audioElement!.addEventListener('loadedmetadata', () => resolve(), { once: true });
    audioElement!.addEventListener('error', () => resolve(), { once: true });
  });

  audioDuration = audioElement.duration || 0;
  // audioBuffer is no longer used — set to a sentinel so guards like
  // `if (!audioBuffer) return;` still work correctly.
  audioBuffer = {} as unknown as AudioBuffer;

  // Connect the HTMLAudioElement into the Web Audio graph.
  // This is required for:
  //  1. AudioContext-based effects (GainNode, etc.)
  //  2. Android AudioManager registration (same as Spotify/YouTube)
  //  3. Keeping the AudioContext alive on iOS screen lock
  if (audioCtx && audioCtx.state !== 'closed') {
    try {
      const mediaSource = audioCtx.createMediaElementSource(audioElement);
      mediaSource.connect(audioCtx.destination);
      audioMediaSource = mediaSource;
    } catch (e) {
      // createMediaElementSource throws if the element is already connected.
      // This can happen on re-init. Safe to ignore — existing connection is fine.
      console.warn('[Cinewav] createMediaElementSource in initAudio:', e);
    }
  }

  // Wire up the onended handler for post-show keepalive.
  audioElement.onended = () => {
    if (isPlaying) {
      isPlaying = false;
      albumArt.classList.remove('playing');
      if (uiInterval)    { clearInterval(uiInterval);    uiInterval    = null; }
      if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
      driftOutOfRangeCount = 0;
      updatePlayPauseBtn();
      if (!masterIsPlaying) setSyncStatus('synced', 'Show ended');
      startSilentKeepalive();
      startPostShowPolling();
    }
  };

  pTotalTime.textContent = formatTime(audioDuration);
  playPauseBtn.disabled  = false;
  resyncBtn.disabled     = false;
  redownloadBtn.disabled = false;
  // Android fix C: start the health-check timer that recovers from silent
  // AudioContext suspension (statechange may not fire on Android Chrome).
  startHealthCheck();
}

/**
 * FIX 3: Silent keepalive using AudioBufferSourceNode.
 * Keeps the AudioContext alive on iOS when screen is locked — without using
 * a looping HTMLAudioElement (which caused 1-second OS media interruptions).
 * A looping silent AudioBufferSourceNode is invisible to the OS media session.
 *
 * Android fix: ALSO start an HTMLAudioElement playing silent.mp3 in a loop.
 * The AudioBufferSourceNode is invisible to Android's AudioManager, so Samsung
 * One UI terminates the Chrome renderer within 3 seconds of screen lock.
 * An HTMLAudioElement registers with Android's AudioManager (the same API
 * Spotify/YouTube use), which tells Samsung's battery manager this process is
 * actively playing audio — do not suspend it.
 *
 * iOS note: the HTMLAudioElement is NOT started on iOS because it causes
 * 1-second OS media interruptions on each loop iteration. iOS only needs the
 * AudioBufferSourceNode to keep the AudioContext alive.
 */
function startSilentKeepalive() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  // ── AudioBufferSourceNode silent loop (iOS + all platforms) ───────────────
  // NOTE: With HTMLAudioElement as the primary source, the audioElement itself
  // keeps the AudioContext alive on iOS. The AudioBufferSourceNode silent loop
  // is kept as a belt-and-suspenders measure for the case where the audioElement
  // is paused (e.g. between show end and next play command).
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

  // ── HTMLAudioElement (Android only) ──────────────────────────────────────
  // Detect Android: navigator.userAgent contains 'Android' and NOT 'iPhone'/'iPad'.
  // We skip this on iOS to avoid the 1-second interruption bug.
  const isAndroid = /Android/i.test(navigator.userAgent) && !/iPhone|iPad/i.test(navigator.userAgent);
  if (isAndroid) {
    startAndroidKeepalive();
  }
}

/**
 * Start the Android HTMLAudioElement keepalive.
 *
 * KEY CHANGE (Option A): After play() resolves, we pipe the keepalive element
 * through the AudioContext via createMediaElementSource(). This does two things:
 *
 * 1. Forces Chrome to keep the AudioContext running as long as the element plays.
 *    Previously the HTMLAudioElement was disconnected from the AudioContext graph,
 *    so Android's AudioManager could not see it as a real media session.
 *
 * 2. Registers a proper MediaElementAudioSourceNode with Android's AudioManager.
 *    Android now sees a real HTMLAudioElement connected to a real AudioContext —
 *    the same pattern Spotify/YouTube Music/FPlayWeb use — and grants full audio
 *    focus, preventing Samsung/Oppo/ZTE battery managers from freezing the renderer.
 *
 * The GainNode is set to 0 so no actual sound is output (the real show audio
 * comes from AudioBufferSourceNode as before). The keepalive element itself
 * plays silent60.mp3 at volume 0.001 as a belt-and-suspenders measure.
 *
 * Safe to call multiple times — idempotent.
 */
function startAndroidKeepalive() {
  if (androidKeepalive) return; // already running
  if (!audioCtx || audioCtx.state === 'closed') return; // no context yet

  const audio = new Audio('/silent60.mp3');
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  audio.playsInline = true;
  audio.loop   = true;
  audio.volume = 0.001;
  audio.muted  = true;

  // Set mediaSession metadata so Android's AudioManager identifies this as a
  // legitimate media session (same as Spotify/YouTube Music).
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Cinewav',
      artist: 'Live Event Audio',
      album: 'Cinewav'
    });
  }

  audio.play().then(() => {
    // Unmute after play() resolves to bypass strict Android autoplay policies.
    audio.muted = false;

    // ── createMediaElementSource() bridge ────────────────────────────────────
    // Connect the keepalive element into the AudioContext graph. This is the
    // critical step: it tells Android's AudioManager that this AudioContext
    // owns a real HTMLAudioElement media session. Without this, the AudioContext
    // (and the show audio inside it) is invisible to the OS and gets killed.
    //
    // We guard against the AudioContext being closed/replaced between the
    // play() call and this .then() callback (e.g. rapid seek during startup).
    if (audioCtx && audioCtx.state !== 'closed' && !androidKeepaliveSource) {
      try {
        const ctx = audioCtx;
        const mediaSource = ctx.createMediaElementSource(audio);
        // Route through a silent GainNode — we do not want to hear the
        // silent60.mp3 file through the speakers, only through the OS.
        const silentGain = ctx.createGain();
        silentGain.gain.value = 0;
        mediaSource.connect(silentGain);
        silentGain.connect(ctx.destination);
        androidKeepaliveSource = mediaSource;
      } catch (e) {
        // createMediaElementSource can throw if the element is already
        // connected to a different AudioContext. Log and continue — the
        // HTMLAudioElement alone is still better than nothing.
        console.warn('[Cinewav] createMediaElementSource failed:', e);
      }
    }
  }).catch(() => {
    // Autoplay blocked — this should not happen here because we are called
    // from within startPlayback() which is triggered by a user gesture or
    // an incoming sync command after the user has already interacted.
    // If it does fail, the AudioBufferSourceNode keepalive still works for iOS.
  });

  androidKeepalive = audio;
}

function stopAndroidKeepalive() {
  // Disconnect the createMediaElementSource bridge first to avoid
  // "already connected to a different AudioContext" errors on restart.
  if (androidKeepaliveSource) {
    try { androidKeepaliveSource.disconnect(); } catch { /* already disconnected */ }
    androidKeepaliveSource = null;
  }
  if (!androidKeepalive) return;
  androidKeepalive.pause();
  androidKeepalive.src = '';
  androidKeepalive = null;
}

/**
 * Returns current playback position in seconds using the wall clock.
 * Uses Date.now() instead of audioCtx.currentTime because audioCtx.currentTime
 * freezes when the AudioContext is suspended on Android, causing drift
 * calculations to go wildly wrong. Date.now() always advances regardless of
 * AudioContext state, making position tracking robust on Android Chrome.
 */
function getCurrentPosition(): number {
  if (!isPlaying) return playStartPos;
  return playStartPos + (Date.now() - playStartWallTime) / 1000;
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
 * Synchronous — no async/await. Stops the existing node, creates a new one,
 * and records playStartWallTime = Date.now() for position tracking.
 *
 * Position tracking uses Date.now() (wall clock) rather than
 * audioCtx.currentTime. This is critical for Android: audioCtx.currentTime
 * freezes when the context is suspended, causing drift calculations to
 * wildly overshoot. Date.now() always advances regardless of context state.
 *
 * The AudioContext is kept alive permanently. No close/recreate on seek.
 * If the context is not running when this is called, we start the node
 * anyway (it will produce audio once the context resumes) and record
 * playStartWallTime so position tracking is correct from the moment
 * the context actually starts playing.
 */
function startPlayback(rawPosition: number): void {
  // Stop post-show polling — playback is resuming.
  stopPostShowPolling();

  if (!audioCtx || !audioElement) return;

  // Stop all timers
  if (uiInterval)    { clearInterval(uiInterval);    uiInterval    = null; }
  if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
  driftOutOfRangeCount = 0;
  isPlaying = false;

  // Read outputLatency NOW (not at context creation) — it is only populated
  // after the context is running and has processed its first audio frame.
  // On Android with latencyHint:'playback' this is typically 200–350ms.
  // On iOS it is near-zero.
  if (audioCtx.state === 'running') {
    const measuredLatency = Math.round(
      ((audioCtx.outputLatency ?? 0) + (audioCtx.baseLatency ?? 0)) * 1000
    );
    if (measuredLatency > 0) platformLatencyMs = measuredLatency;
  }

  // Apply manual offset and platform latency compensation.
  // playStartPos is in MASTER-space (no platformLatencyMs) so getCurrentPosition()
  // stays in the same coordinate space as getEstimatedMasterPosition().
  const masterSpacePos = rawPosition + (manualOffsetMs / 1000);
  const seekPos        = masterSpacePos + (platformLatencyMs / 1000);
  const clamped        = Math.max(0, Math.min(seekPos, audioDuration - 0.1));
  const clampedMaster  = Math.max(0, Math.min(masterSpacePos, audioDuration - 0.1));

  // Seek the HTMLAudioElement to the target position.
  // HTMLAudioElement.currentTime seek is accurate to ~10ms for MP3 files.
  audioElement.currentTime = clamped;

  // Record wall-clock start time BEFORE play() so position tracking is
  // correct from the moment the seek completes, even if play() is async.
  playStartWallTime = Date.now();
  playStartPos      = clampedMaster;
  isPlaying         = true;

  // Resume AudioContext if needed, then play.
  const doPlay = () => {
    if (!audioElement) return;
    audioElement.play().catch((e) => {
      // Autoplay blocked — set pendingPlaybackPos so the statechange listener
      // retries when the user next interacts with the page.
      console.warn('[Cinewav] audioElement.play() blocked:', e);
      isPlaying = false;
      pendingPlaybackPos = rawPosition;
    });
  };

  if (audioCtx.state === 'running') {
    doPlay();
  } else {
    // Context not yet running — resume first, then play.
    audioCtx.resume().then(doPlay).catch(doPlay);
  }

  startSilentKeepalive();
  albumArt.classList.add('playing');
  waitingOverlay.classList.add('hidden');
  updatePlayPauseBtn();
  startUILoop();
  startDriftLoop();
  updateMediaSession();
}

function stopPlayback() {
  if (audioElement) {
    audioElement.pause();
  }
  if (uiInterval)    { clearInterval(uiInterval);    uiInterval    = null; }
  if (driftInterval) { clearInterval(driftInterval); driftInterval = null; }
  driftOutOfRangeCount = 0;
  isPlaying = false;
  albumArt.classList.remove('playing');
  updatePlayPauseBtn();
  updateMediaSession(); // update OS session to 'paused' so Samsung doesn't kill us
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
    // Update MediaSession position state every 250ms so the OS lock-screen
    // widget shows the correct playhead and Samsung sees an active session.
    updateMediaSession();
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
        startPlayback(targetRaw);
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
    if (!audioCtx || !audioBuffer) return;
    if (audioCtx.state === 'running') return; // all good

    // Context is not running — attempt recovery.
    // Do NOT restart playback based on stale masterIsPlaying here: that flag
    // may be wrong if a pause command was missed while the context was
    // suspended. Instead, resume the context and request a fresh authoritative
    // state from the server. The incoming sync command will restart playback
    // only if the master is actually still playing.
    setSyncStatus('drifted', 'Recovering audio…');
    try {
      await resumeAudioContext();
    } catch { /* ignore */ }

    // Request fresh state from server — this will deliver the correct
    // play/pause state and position, overriding any stale local flags.
    sendToSW({ type: 'sw_hard_resync' });
  }, 2000);
}

// ── Post-Show Polling ────────────────────────────────────────────────────────
// After the track ends naturally, keep the SW and AudioContext alive by
// polling the server for state every 20 seconds. This ensures the device
// immediately re-syncs when the master player seeks back or restarts the show,
// even hours later. The poll is stopped as soon as playback resumes.
let postShowPollInterval: ReturnType<typeof setInterval> | null = null;

function startPostShowPolling() {
  if (postShowPollInterval) return; // already running
  postShowPollInterval = setInterval(() => {
    // Keep the SW alive by sending a message to it every 20s.
    // Also request a fresh server state so we snap back immediately
    // if the master restarts the show.
    sendToSW({ type: 'sw_hard_resync' });
  }, 20000);
}

function stopPostShowPolling() {
  if (postShowPollInterval) {
    clearInterval(postShowPollInterval);
    postShowPollInterval = null;
  }
}

// ── Background Sync Heartbeat (Samsung screen-lock recovery) ─────────────────
// Samsung One UI kills the Chrome renderer (and therefore the Service Worker)
// within 1-3 seconds of screen lock, even with Web Lock + event.waitUntil held.
// The SW reconnects automatically (1s timer), but the main thread has no way
// to know the screen is locked or that commands were missed.
//
// Solution: while the show is playing, the main thread sends a sw_hard_resync
// every 5 seconds. After the SW reconnects (1s), the next poll fires within
// 4 seconds at most, delivering a fresh authoritative position from the server.
// Worst-case sync gap on Samsung = ~5 seconds (1s reconnect + up to 4s poll).
//
// This also keeps the SW alive on stock Android as a belt-and-suspenders
// measure alongside the Web Lock and waitUntil keep-alive.
let bgSyncHeartbeatInterval: ReturnType<typeof setInterval> | null = null;

function startBgSyncHeartbeat() {
  if (bgSyncHeartbeatInterval) return;
  bgSyncHeartbeatInterval = setInterval(() => {
    // Send a heartbeat every 30 seconds.
    //
    // Purpose: wake up the SW if Android killed it while the screen was off,
    // and request a fresh server position so the device snaps back into sync
    // after a reconnect.
    //
    // Why 30s (not 5s):
    // sw_hard_resync triggers startBurst() in the SW, which fires 16 pings at
    // 75ms intervals (1.2s total) and resets burstComplete=false. At 5s intervals
    // the SW was constantly in burst mode — never settling into the quiet 4s
    // keepalive. The SW's own 20s WS heartbeat handles protocol-level keepalive
    // independently. The drift loop (500ms) handles local resync. This heartbeat
    // only needs to handle the case where the SW was killed and needs waking.
    // 30s is more than sufficient for that — worst-case recovery gap is 30s.
    sendToSW({ type: 'sw_hard_resync' });
  }, 30000);
}

function stopBgSyncHeartbeat() {
  if (bgSyncHeartbeatInterval) {
    clearInterval(bgSyncHeartbeatInterval);
    bgSyncHeartbeatInterval = null;
  }
}

// ── Media Session ─────────────────────────────────────────────────────────────
// Samsung One UI aggressively kills Chrome processes on screen lock unless the
// page has a fully-registered MediaSession (metadata + playbackState + action
// handlers). Without action handlers, Samsung treats the session as incomplete
// and terminates it. With a complete session, Samsung's battery manager treats
// Chrome the same as Spotify or YouTube — it survives screen lock.
function setupMediaSession(title: string) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title, artist: 'Cinewav', album: `Show: ${showId}`,
    artwork: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });

  // Register all standard action handlers so Samsung recognises this as a
  // legitimate media session. The handlers mirror what the play/pause button
  // and resync button already do — they just expose them to the OS.
  navigator.mediaSession.setActionHandler('play', () => {
    if (!audioBuffer) return;
    if (!swConnected) {
      // OS lock-screen play button pressed while disconnected.
      // Request reconnect; the server reply will start playback at the correct position.
      setSyncStatus('waiting', 'Reconnecting…');
      sendToSW({ type: 'sw_hard_resync' });
      return;
    }
    // Connected — request fresh state from server so we start at the right position.
    sendToSW({ type: 'sw_hard_resync' });
    setSyncStatus('syncing', 'Syncing…');
  });

  navigator.mediaSession.setActionHandler('pause', () => {
    stopPlayback();
    pendingPlaybackPos = null;
    setSyncStatus('synced', 'Paused locally');
  });

  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) startPlayback(details.seekTime);
  });

  navigator.mediaSession.setActionHandler('seekbackward', () => {
    startPlayback(Math.max(0, getCurrentPosition() - 10));
  });

  navigator.mediaSession.setActionHandler('seekforward', () => {
    startPlayback(Math.min(audioDuration, getCurrentPosition() + 10));
  });
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

  // Update position state so the OS lock-screen media widget shows the
  // correct playhead position. This also signals to Samsung's battery manager
  // that the media session is actively progressing.
  if (isPlaying && audioDuration > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration:     audioDuration,
        position:     Math.min(getCurrentPosition(), audioDuration),
        playbackRate: 1,
      });
    } catch { /* setPositionState not supported on all browsers */ }
  }
}

// ── Play/Pause Button ─────────────────────────────────────────────────────────
function updatePlayPauseBtn() {
  playPauseBtn.innerHTML = isPlaying ? '&#9646;&#9646;' : '&#9654;';
  playPauseBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
}

playPauseBtn.addEventListener('click', () => {
  if (!audioBuffer) return;

  if (isPlaying) {
    // Pausing locally is always allowed — it does not depend on the connection.
    stopPlayback();
    pendingPlaybackPos = null;
    setSyncStatus('synced', 'Paused locally');
  } else {
    // Starting playback requires a live connection so we get the authoritative
    // position from the server. Never start from a stale local estimate.
    if (!swConnected) {
      // Actively force a reconnect — do not just show a status and return.
      // The watchdog fires every 5s but the user tapping Play expects an
      // immediate response. Re-register the SW pipeline right now.
      setSyncStatus('waiting', 'Reconnecting…');
      if (currentWsUrl) {
        syncSW = null;
        registerSyncWorker(currentWsUrl).catch(() => {});
      } else {
        sendToSW({ type: 'sw_hard_resync' });
      }
      return;
    }
    // Request fresh state from server; the incoming sw_command will start playback.
    sendToSW({ type: 'sw_hard_resync' });
    setSyncStatus('syncing', 'Syncing…');
    startSyncingTimeout();
  }
});

// ── Show Command Handler ─────────────────────────────────────────────────────────────
function handleShowCommand(cmd: ShowCommand) {
  if (!audioBuffer) {
    pendingCommand = cmd;
    return;
  }

  // FIX 1: use cmd.enqueuedAt (stamped on main thread when command entered
  // the queue) rather than Date.now() here.
  masterPosition   = cmd.position;
  masterPositionAt = cmd.enqueuedAt ?? Date.now();

  switch (cmd.action) {
    case 'play': {
      masterIsPlaying = true;
      pendingPlaybackPos = null;
      if (cmd.audioFile) trackName.textContent = cmd.audioFile;
      ensureAudioContext();
      if (audioCtx && audioCtx.state === 'running') {
        // AudioContext is already running — start immediately.
        startPlayback(cmd.position);
        setSyncStatus('synced', 'In sync');
      } else {
        // AudioContext is suspended (common on Android when the gesture window
        // expired during the async audio download). Set pendingPlaybackPos so
        // the statechange listener fires startPlayback() the moment the context
        // actually resumes. resumeAudioContext() triggers the resume attempt.
        pendingPlaybackPos = cmd.position;
        setSyncStatus('syncing', 'Starting audio…');
        resumeAudioContext().then(() => {
          // If statechange already fired and cleared pendingPlaybackPos, do nothing.
          // If the context is now running but statechange hasn't fired yet, start now.
          if (pendingPlaybackPos !== null && audioCtx && audioCtx.state === 'running') {
            const pos = pendingPlaybackPos;
            pendingPlaybackPos = null;
            startPlayback(pos);
            setSyncStatus('synced', 'In sync');
          }
        }).catch(() => {});
      }
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
      stopPlayback();
      pendingPlaybackPos = null;
      playStartPos = cmd.position;
      if (masterIsPlaying) {
        ensureAudioContext();
        if (audioCtx && audioCtx.state === 'running') {
          startPlayback(cmd.position);
          setSyncStatus('synced', 'In sync');
        } else {
          pendingPlaybackPos = cmd.position;
          setSyncStatus('syncing', 'Starting audio…');
          resumeAudioContext().then(() => {
            if (pendingPlaybackPos !== null && audioCtx && audioCtx.state === 'running') {
              const pos = pendingPlaybackPos;
              pendingPlaybackPos = null;
              startPlayback(pos);
              setSyncStatus('synced', 'In sync');
            }
          }).catch(() => {});
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
function doManualResync() {
  if (!audioBuffer) return;
  const masterPos = getEstimatedMasterPosition();
  if (masterIsPlaying) {
    pendingPlaybackPos = null;
    ensureAudioContext();
    resumeAudioContext().catch(() => {});
    startPlayback(masterPos);
    setSyncStatus('synced', 'Resynced');
  } else {
    stopPlayback();
    pendingPlaybackPos = null;
    playStartPos = masterPos;
    setSyncStatus('synced', 'Paused');
  }
}

resyncBtn.addEventListener('click', () => {
  if (!swConnected) {
    // Actively force a reconnect — same as the play button.
    setSyncStatus('waiting', 'Reconnecting…');
    if (currentWsUrl) {
      syncSW = null;
      registerSyncWorker(currentWsUrl).catch(() => {});
    } else {
      sendToSW({ type: 'sw_hard_resync' });
    }
    return;
  }
  sendToSW({ type: 'sw_hard_resync' });
  // Only apply local resync if we have a fresh-enough clock (burst complete).
  // The server reply will arrive within ~200ms and override this anyway.
  doManualResync();
  resyncBtn.textContent = '✓ Synced!';
  setTimeout(() => { resyncBtn.innerHTML = '&#8635; Resync Now'; }, 1500);
  startSyncingTimeout();
});

// ── Force Re-download ───────────────────────────────────────────────────────────
// Clears the local IndexedDB audio cache for this show and re-fetches the
// current file from the server. Use when the master has uploaded a new audio
// file but the device is still playing the old cached version.
redownloadBtn.addEventListener('click', async () => {
  if (!showId || !serverBaseUrl) return;
  redownloadBtn.disabled = true;
  redownloadBtn.textContent = 'Clearing cache…';

  // 1. Delete the cached audio for this show
  const { deleteAudio } = await import('./audioStorage');
  await deleteAudio(showId);

  // 2. Fetch the current server state to get the latest filename + hash
  redownloadBtn.textContent = 'Fetching…';
  try {
    const stateRes = await fetch(`${serverBaseUrl}/api/show/${showId}/state`);
    if (!stateRes.ok) throw new Error(`Server error: ${stateRes.status}`);
    const state = await stateRes.json() as {
      audioFile?: string;
      audioHash?: string;
      audioReady?: boolean;
    };

    if (!state.audioReady || !state.audioFile) {
      redownloadBtn.textContent = 'No audio on server';
      setTimeout(() => {
        redownloadBtn.innerHTML = '&#8635; Force Re-download Audio';
        redownloadBtn.disabled = false;
      }, 2000);
      return;
    }

    // 3. Stop any currently-playing audio before replacing the buffer.
    //    Without this the old audio keeps playing underneath the new file.
    stopPlayback();
    pendingPlaybackPos = null;

    // 4. Download the new file (switches to download screen automatically)
    setSyncStatus('syncing', 'Downloading audio…');
    trackName.textContent = 'Downloading audio…';
    const { saveAudio } = await import('./audioStorage');
    const buf = await downloadAudioFile(
      `${serverBaseUrl}/api/show/${showId}/audio`,
      state.audioFile,
    );
    await saveAudio(showId, state.audioFile, buf, state.audioHash || '');
    currentAudioHash = state.audioHash || '';  // update in-memory hash
    await initAudio(buf);

    // 5. Return to the player screen — downloadAudioFile() switches to the
    //    download screen but never switches back; we must do it explicitly here.
    showScreen('player');
    trackName.textContent = state.audioFile;
    setupMediaSession(state.audioFile);
    setSyncStatus('waiting', 'Audio ready — waiting for show');

    // 6. Request a fresh sync from the server so the new audio starts at the
    //    correct position if the show is already playing.
    sendToSW({ type: 'sw_hard_resync' });

    redownloadBtn.innerHTML = '&#8635; Force Re-download Audio';
    redownloadBtn.disabled = false;
  } catch (err) {
    // On error, return to the player screen so the user is not stuck on the
    // download screen with no way to recover.
    showScreen('player');
    setSyncStatus('waiting', 'Download failed — retry');
    redownloadBtn.innerHTML = '&#8635; Force Re-download Audio';
    redownloadBtn.disabled = false;
  }
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

// ── Service Worker Message Handler ──────────────────────────────────────────────────────
function handleSWMessage(event: MessageEvent) {
  const msg = event.data as SWMessage;
  if (!msg?.type) return;
  resetSWWatchdog(); // any message from SW means it's alive
  switch (msg.type) {
    case 'sw_connected':
      // setConnectionState(true) re-enables buttons, sets status, and sends
      // sw_hard_resync so the device always gets authoritative state on reconnect.
      // This replaces the old isReconnect-only path: we ALWAYS resync on connect
      // because even the first connection needs the current server state.
      setConnectionState(true);
      setSyncStatus('syncing', 'Syncing clock…');
      // setConnectionState already calls startSyncingTimeout via sendToSW resync path,
      // but setSyncStatus('syncing') above would have cleared it if status was 'waiting'.
      // Restart it explicitly here so the 6s auto-retry is active from this point.
      startSyncingTimeout();
      break;

    case 'sw_disconnected':
      // setConnectionState(false) disables buttons and shows "Reconnecting…"
      // so the user cannot start independent playback while the WS is down.
      setConnectionState(false);
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
      // Detect a new audio file by comparing the server's audioHash against
      // currentAudioHash — an in-memory variable updated whenever audio is
      // loaded. This avoids reading IndexedDB on every sync message, which
      // was causing a 20–30 second startup delay on Android (IndexedDB reads
      // are async and slow; during the 16-ping burst they queued up and
      // blocked the command queue from processing the play command).
      if (
        msg.audioHash &&
        msg.audioFile &&
        showId &&
        !isRedownloading &&
        currentAudioHash &&                        // we have audio loaded
        currentAudioHash !== msg.audioHash         // it's a different file
      ) {
        handleAudioReady(msg.audioFile, msg.audioHash);
      }
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

  // Guard against concurrent re-downloads triggered by rapid sync messages.
  if (isRedownloading) return;
  isRedownloading = true;

  // Stop any currently-playing audio before replacing the buffer.
  // Without this the old audio keeps playing underneath the new file.
  stopPlayback();
  pendingPlaybackPos = null;

  setSyncStatus('syncing', 'Downloading audio…');
  trackName.textContent = 'Downloading audio…';
  try {
    const buf = await downloadAudioFile(`${serverBaseUrl}/api/show/${showId}/audio`, filename);
    await saveAudio(showId, filename, buf, hash);
    currentAudioHash = hash;  // update in-memory hash so sw_command detects future changes
    await initAudio(buf);
    // Return to the player screen — downloadAudioFile() switches to the
    // download screen but never switches back.
    showScreen('player');
    trackName.textContent = filename;
    setupMediaSession(filename);
    setSyncStatus('waiting', 'Audio ready — waiting for show');
    // Request a fresh sync so the new audio starts at the correct position
    // if the show is already playing.
    sendToSW({ type: 'sw_hard_resync' });
  } catch {
    showScreen('player');
    setSyncStatus('waiting', 'Download failed — retry');
  } finally {
    isRedownloading = false;
  }
}

// ── Visibility Change — Hard Resync on Screen Wake ────────────────────────────
async function handleScreenWake() {
  // Tab came back to foreground after screen unlock.
  //
  // On Oppo (Android 16) and other stock-Android devices, a 10-15 minute
  // screen-off period causes Android to kill the Chrome renderer process
  // entirely — not just suspend it. When this happens:
  //   1. The SW's JavaScript context is destroyed (Web Lock released).
  //   2. navigator.serviceWorker.controller becomes null.
  //   3. The SW is in a 'redundant' or 'activating' state, not 'activated'.
  //   4. postMessage() to the old syncSW reference silently drops the message.
  //
  // The fix: always check if the SW controller is gone on wake and re-register
  // the full SW + WebSocket pipeline before attempting a resync. Without this,
  // sendToSW() drops the sw_hard_resync into a dead reference, the WS never
  // reconnects, and the UI stays orange/unresponsive until a full page reload.

  // Step 1: Recover AudioContext
  if (audioCtx) {
    ensureAudioContext();
    await resumeAudioContext();
  }

  // Step 2: Check if the SW controller is still alive.
  // If it is gone, the SW process was killed — re-register the full pipeline.
  // This is the critical fix for the 10-15 minute screen-off unresponsive state.
  const controllerAlive = !!navigator.serviceWorker?.controller;
  if (!controllerAlive && currentWsUrl) {
    console.warn('[ScreenWake] SW controller gone — re-registering SW pipeline');
    // Reset syncSW so sendToSW doesn't use the dead reference
    syncSW = null;
    swConnected = false;
    playPauseBtn.disabled = true;
    resyncBtn.disabled    = true;
    setSyncStatus('waiting', 'Reconnecting…');
    // Re-register will call sw_init → connectWs → sw_connected → setConnectionState(true)
    registerSyncWorker(currentWsUrl).catch(() => {});
    // AudioContext keepalive will be restarted after sw_connected fires
    return;
  }

  // Step 3: SW is alive — request fresh authoritative state.
  // The server will reply with the current play/pause state and position.
  // Do NOT use stale local masterIsPlaying — it may be wrong if commands
  // were missed while the screen was off.
  sendToSW({ type: 'sw_hard_resync' });

  // Step 4: Restart the silent keepalive if the AudioContext is running.
  // Playback will be restarted by the incoming sync command from the server.
  if (audioCtx?.state === 'running') {
    startSilentKeepalive();
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  await handleScreenWake();
});

// Samsung One UI sometimes fires 'pageshow' instead of 'visibilitychange'
// when the screen is unlocked (bfcache restore path). Listen for both.
window.addEventListener('pageshow', async (e) => {
  // e.persisted = true means the page was restored from bfcache (screen wake).
  // e.persisted = false is the initial page load — ignore it here.
  if (e.persisted) await handleScreenWake();
});

// ── Service Worker Setup ──────────────────────────────────────────────────────

// ── SW Update Banner ─────────────────────────────────────────────────────────────
function showUpdateBanner(waitingSW: ServiceWorker) {
  const banner = document.getElementById('update-banner') as HTMLDivElement | null;
  if (!banner) return;
  banner.classList.add('visible');

  const activate = () => {
    // Tell the waiting SW to skip waiting and become the active SW immediately.
    waitingSW.postMessage({ type: 'SKIP_WAITING' });
    // Reload once the new SW takes control.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    }, { once: true });
  };

  banner.addEventListener('click', activate, { once: true });
  banner.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') activate();
  }, { once: true });
}

// Main-thread watchdog: if the SW goes silent for >25 seconds while we are
// supposed to be connected, force a hard resync. This catches the case where
// Android Chrome kills the SW process silently (no sw_disconnected message).
let lastSWMessageAt = 0;
let swWatchdogTimer: ReturnType<typeof setInterval> | null = null;

function resetSWWatchdog() {
  lastSWMessageAt = Date.now();
}

function startSWWatchdog(wsUrl: string) {
  if (swWatchdogTimer) clearInterval(swWatchdogTimer);
  lastSWMessageAt = Date.now();
  swWatchdogTimer = setInterval(() => {
    const silentMs = Date.now() - lastSWMessageAt;

    // Primary check: SW controller is gone.
    // This is the definitive sign that Android killed the renderer process
    // (common after 10-15 min screen-off on Oppo/stock Android, and after
    // 1-3 sec on Samsung without Unrestricted battery). When the controller
    // is null, postMessage() silently drops all messages — the SW will never
    // reconnect on its own because its JS context is destroyed.
    if (!navigator.serviceWorker.controller) {
      console.warn('[Watchdog] SW controller gone — re-registering');
      lastSWMessageAt = Date.now();
      syncSW = null;
      setConnectionState(false);
      registerSyncWorker(wsUrl).catch(() => {});
      return;
    }

    // Secondary check: SW is alive but has gone silent for >8s.
    // This catches the case where the WS died but the SW process survived
    // (e.g. NAT timeout, server restart). Send a hard resync to wake it.
    if (silentMs > 8000) {
      console.warn('[Watchdog] SW silent for', silentMs, 'ms — forcing resync');
      lastSWMessageAt = Date.now();
      sendToSW({ type: 'sw_hard_resync' });
    }
  }, 5000);
}

// Track whether the SW message listener has been registered to avoid duplicates
// when registerSyncWorker is called multiple times (e.g. on screen wake re-registration).
let swMessageListenerRegistered = false;

async function registerSyncWorker(wsUrl: string): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    console.warn('SW not supported — using direct WebSocket');
    startDirectWebSocket(wsUrl);
    return;
  }

  // Only add the message listener once — re-registration on screen wake must not
  // add duplicate listeners, which would cause every SW message to be processed
  // twice (double resyncs, double playback starts, etc.).
  if (!swMessageListenerRegistered) {
    navigator.serviceWorker.addEventListener('message', handleSWMessage);
    swMessageListenerRegistered = true;
  }

  const initSW = (sw: ServiceWorker) => {
    syncSW = sw;
    sw.postMessage({ type: 'sw_init', wsUrl, showId });
    startSWWatchdog(wsUrl);
  };

  // Force update check so the new SW (with keep-alive lock) activates immediately
  // instead of waiting for all tabs to close. skipWaiting() in the SW handles
  // the install side; update() + clients.claim() handles the activate side.
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      await reg.update();

      // If a new SW is already waiting (downloaded but not yet active),
      // show the update banner so the user can activate it with one tap.
      if (reg.waiting) showUpdateBanner(reg.waiting);

      // Also listen for future waiting SWs (e.g. update arrives while app is open).
      reg.addEventListener('updatefound', () => {
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(newSW);
          }
        });
      });
    }
  } catch { /* ignore — update is best-effort */ }

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

    // Update the in-memory hash so sw_command can detect future file changes
    // without reading IndexedDB on every message.
    if (audioData?.hash) currentAudioHash = audioData.hash;

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
    currentWsUrl = wsUrl; // store for re-registration after long screen-off kill
    await registerSyncWorker(wsUrl);
    setSyncStatus('syncing', 'Syncing clock…');
    // Start the background sync heartbeat that keeps the device in sync
    // even when Samsung kills the SW on screen lock.
    startBgSyncHeartbeat();

    // 7. Decode audio
    if (audioData) {
      await initAudio(audioData.data);
      // Start silent keepalive to keep AudioContext alive on iOS screen lock (FIX 3)
      startSilentKeepalive();

      // Fast path: use pendingCommand if one arrived while audio was decoding.
      // pendingCommand is the buffered 'welcome' from the SW — it is already
      // available the moment initAudio() returns, so no network round-trip needed.
      //
      // The previous approach (discard pendingCommand + sw_hard_resync) caused a
      // 20-second delay because sw_hard_resync triggers a new 16-ping burst in the
      // SW before the reply is sent, and on a slow mobile connection this took
      // 15-20 seconds.
      //
      // Pause fix: the old code skipped handleShowCommand for pause commands
      // (it only called startPlayback when state.isPlaying was true). Now we
      // call handleShowCommand for ALL pendingCommand actions — play, pause, seek.
      // handleShowCommand correctly sets the UI to 'Paused' for pause commands.
      //
      // Fallback: if no pendingCommand arrived (e.g. the SW was still connecting
      // when initAudio finished), fall back to state.isPlaying from the HTTP
      // response, or send sw_hard_resync as a last resort.
      if (pendingCommand) {
        const cmd = pendingCommand;
        pendingCommand = null;
        // Compensate for time elapsed while audio was decoding
        if (cmd.action === 'play') {
          const elapsed = (Date.now() - (cmd.receivedAt ?? Date.now())) / 1000;
          cmd.position += elapsed;
          masterPosition   = cmd.position;
          masterPositionAt = Date.now();
        }
        enqueueCommand(cmd);
      } else if (state.isPlaying) {
        // No pending command but server says playing — start at estimated position
        const masterPos = getEstimatedMasterPosition();
        await resumeAudioContext();
        if (audioCtx && audioCtx.state === 'running') {
          startPlayback(masterPos);
          setSyncStatus('synced', 'In sync');
        } else {
          // AudioContext still suspended after resume attempt (Android gesture expired).
          // Set pendingPlaybackPos so statechange fires startPlayback() when it resumes.
          pendingPlaybackPos = masterPos;
          setSyncStatus('syncing', 'Starting audio…');
        }
      } else {
        // No pending command and server says paused — request fresh state
        // (this handles the screen-wake reconnect case where state may be stale)
        sendToSW({ type: 'sw_hard_resync' });
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

// ── Android Battery Prompt ────────────────────────────────────────────────────
// Samsung One UI kills Chrome's renderer process within 3 seconds of screen
// lock unless Chrome has "Unrestricted" battery usage. No JavaScript technique
// can override this OS-level policy. The only reliable fix is a one-time user
// setting change. We detect Android and show this prompt once per device.
const BATTERY_PROMPT_KEY = 'cinewav_battery_prompt_done';
const androidBatteryPrompt = document.getElementById('android-battery-prompt')!;
const batteryPromptDone    = document.getElementById('battery-prompt-done')!;
const batteryPromptSkip    = document.getElementById('battery-prompt-skip')!;

function isAndroidDevice(): boolean {
  return /Android/i.test(navigator.userAgent) && !/iPhone|iPad/i.test(navigator.userAgent);
}

function showAndroidBatteryPrompt() {
  if (!isAndroidDevice()) return;
  if (localStorage.getItem(BATTERY_PROMPT_KEY)) return;
  androidBatteryPrompt.classList.add('visible');
}

function dismissAndroidBatteryPrompt(remember: boolean) {
  androidBatteryPrompt.classList.remove('visible');
  if (remember) {
    localStorage.setItem(BATTERY_PROMPT_KEY, '1');
  }
}

batteryPromptDone.addEventListener('click', () => dismissAndroidBatteryPrompt(true));
batteryPromptSkip.addEventListener('click', () => dismissAndroidBatteryPrompt(false));

// Show the prompt on first load for Android devices that haven't dismissed it.
// We show it on the join screen so the user can act before the show starts.
showAndroidBatteryPrompt();

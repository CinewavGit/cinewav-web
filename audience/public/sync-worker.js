/**
 * Cinewav Sync Service Worker
 *
 * Responsibilities:
 *  - Own the WebSocket connection to the Cloudflare Durable Object
 *  - Run NTP ping burst + keepalive pings
 *  - Compute clock offset (median of 16 samples, RTT outlier rejection)
 *  - Receive sync commands and forward to main thread via postMessage
 *  - Reconnect automatically on disconnect
 *
 * This worker does NOT touch audio — that stays on the main thread.
 * Communication with main thread is via self.clients.matchAll() + postMessage.
 *
 * Web Locks: The main thread acquires a lock named 'cinewav-sync-lock' before
 * activating this worker. Only one tab holds the lock at a time.
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const BURST_COUNT           = 16;
const BURST_INTERVAL_MS     = 75;
const KEEPALIVE_INTERVAL_MS = 4000;
const OFFSET_HISTORY_SIZE   = 16;
const RTT_HISTORY_SIZE      = 8;
const RTT_OUTLIER_FACTOR    = 2.5;

//// ── State ───────────────────────────────────────────────────────────────────
let ws             = null;
let wsUrl          = null;
let showId         = null;
let pingTimer      = null;
let reconnectTimer = null;
let burstSent      = 0;
let burstComplete  = false;

let offsetHistory  = [];
let rttHistory     = [];
let clockOffsetMs  = 0;
let rttMs          = 0;

// Buffer the welcome message until we have enough pings for a good clock offset
const MIN_PINGS_BEFORE_WELCOME = 8;
let pendingWelcome = null;

// ── Broadcast to all clients ──────────────────────────────────────────────────
async function broadcast(msg) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage(msg);
  }
}

// ── NTP Helpers ───────────────────────────────────────────────────────────────
function addRttSample(rtt) {
  rttHistory.push(rtt);
  if (rttHistory.length > RTT_HISTORY_SIZE) rttHistory.shift();
}

function addOffsetSample(offset) {
  offsetHistory.push(offset);
  if (offsetHistory.length > OFFSET_HISTORY_SIZE) offsetHistory.shift();
  const sorted = [...offsetHistory].sort((a, b) => a - b);
  clockOffsetMs = sorted[Math.floor(sorted.length / 2)];
}

function sendPing() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping', clientTs: Date.now() }));
  }
}

function startBurst() {
  burstSent     = 0;
  burstComplete = false;
  clearTimeout(pingTimer);

  const firePing = () => {
    sendPing();
    burstSent++;
    if (burstSent >= BURST_COUNT) {
      burstComplete = true;
      startKeepalive();
    } else {
      pingTimer = setTimeout(firePing, BURST_INTERVAL_MS);
    }
  };
  firePing();
}

function startKeepalive() {
  clearInterval(pingTimer);
  pingTimer = setInterval(sendPing, KEEPALIVE_INTERVAL_MS);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWs() {
  if (!wsUrl) return;
  clearTimeout(reconnectTimer);

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type:     'join',
      role:     'audience',
      clientId: `sw-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }));
    startBurst();
    startHeartbeat();  // keep WS alive through Android NAT timeouts and idle detection
    // isReconnect = true when this is NOT the first connection of this SW
    // instance. The main thread uses this to trigger an immediate resync
    // so the device snaps to the current master position without waiting
    // for the next poll interval.
    broadcast({ type: 'sw_connected', isReconnect: (offsetHistory.length > 0) });
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleServerMessage(msg);
  };

  ws.onerror = () => { /* onclose will fire next */ };

  ws.onclose = () => {
    clearTimeout(pingTimer);
    clearInterval(pingTimer);
    broadcast({ type: 'sw_disconnected' });
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  // 1 second reconnect — fast recovery is critical on Samsung where the SW
  // process is killed on screen lock. The sooner we reconnect, the sooner
  // the main-thread polling loop can deliver a fresh server position.
  reconnectTimer = setTimeout(connectWs, 1000);
}

function broadcastCommand(msg) {
  const receivedAt  = msg.receivedAt || Date.now();
  const rawPosition = msg.position || 0;
  const serverTs    = msg.serverTs  || receivedAt;
  const isPlay      = !!(msg.isPlaying || msg.action === 'play');
  const action      = msg.action || (isPlay ? 'play' : 'pause');

  // Transit correction: how many ms elapsed on the server clock since the command was sent?
  // serverNow = clientNow + clockOffsetMs  (converts client wall-clock to server clock)
  // transitMs = serverNow - serverTs       (time since command was dispatched)
  let correctedPosition = rawPosition;
  if (action === 'play') {
    const serverNow = receivedAt + clockOffsetMs;
    const transitMs = Math.max(0, serverNow - serverTs);
    correctedPosition = rawPosition + transitMs / 1000;
  }

  broadcast({
    type:         'sw_command',
    action,
    position:     correctedPosition,
    serverTs,
    masterTs:     msg.masterTs  || 0,
    audioFile:    msg.audioFile || null,
    receivedAt,
    clockOffsetMs,
  });
}

function handleServerMessage(msg) {
  switch (msg.type) {

    case 'pong': {
      const clientTs = msg.clientTs;
      const serverTs = msg.serverTs;
      const now      = Date.now();
      const rtt      = now - clientTs;

      // Outlier rejection
      if (rttHistory.length >= 4) {
        const sorted    = [...rttHistory].sort((a, b) => a - b);
        const medianRtt = sorted[Math.floor(sorted.length / 2)];
        if (rtt > medianRtt * RTT_OUTLIER_FACTOR) {
          // Discard outlier — still broadcast rtt for display
          broadcast({ type: 'sw_rtt', rttMs: rtt, clockOffsetMs, burstComplete });
          break;
        }
      }

      rttMs = rtt;
      addRttSample(rtt);
      const offset = serverTs - (clientTs + rtt / 2);
      addOffsetSample(offset);

      broadcast({
        type:          'sw_clock',
        clockOffsetMs,
        rttMs,
        burstComplete,
      });

      // Flush buffered welcome message once we have enough offset samples
      if (pendingWelcome && offsetHistory.length >= MIN_PINGS_BEFORE_WELCOME) {
        const welcome = pendingWelcome;
        pendingWelcome = null;
        broadcastCommand(welcome);
        // After reconnecting and getting a stable clock, immediately request a
        // fresh resync so the device snaps to the current master position.
        // This ensures that after a WebSocket disconnect (e.g. DO CPU exhaustion
        // during rapid seeks), the device recovers automatically without the
        // user needing to tap Resync.
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resync' }));
        }
      }
      break;
    }

    case 'welcome':
    case 'sync': {
      if (msg.type === 'welcome' && offsetHistory.length < MIN_PINGS_BEFORE_WELCOME) {
        // Clock not ready yet — buffer the welcome and send once we have enough pings
        // Store raw message with receivedAt so we can correct transit time later
        pendingWelcome = { ...msg, receivedAt: Date.now() };
      } else {
        broadcastCommand({ ...msg, receivedAt: Date.now() });
      }
      break;
    }

    case 'audience_count': {
      broadcast({ type: 'sw_audience_count', count: msg.count });
      break;
    }

    case 'audio_ready': {
      broadcast({
        type:      'sw_audio_ready',
        audioFile: msg.audioFile,
        audioHash: msg.audioHash,
      });
      break;
    }
  }
}

// ── Message handler from main thread ─────────────────────────────────────────
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg) return;

  switch (msg.type) {
    case 'sw_init': {
      wsUrl  = msg.wsUrl;
      showId = msg.showId;
      // Reset state for new show
      offsetHistory  = [];
      rttHistory     = [];
      clockOffsetMs  = 0;
      rttMs          = 0;
      burstSent      = 0;
      burstComplete  = false;
      pendingWelcome = null;
      connectWs();
      break;
    }

    case 'sw_disconnect': {
      clearTimeout(reconnectTimer);
      clearTimeout(pingTimer);
      clearInterval(pingTimer);
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (ws) {
        ws.onclose = null;
        ws.close();
        ws = null;
      }
      break;
    }

    case 'sw_ping_now': {
      // Immediate ping requested (e.g. on tab visibility restore)
      sendPing();
      break;
    }

    case 'SKIP_WAITING': {
      // Main thread (update banner) requests immediate SW activation.
      self.skipWaiting();
      break;
    }

    case 'sw_hard_resync': {
      // Main thread requests immediate position — send a ping burst
      // AND request a fresh sync message from the server.
      // If the WebSocket is not open, force an immediate reconnect so the
      // resync request is not silently dropped. The resync will be sent
      // automatically after the welcome is flushed (see pong handler above).
      if (ws && ws.readyState === WebSocket.OPEN) {
        startBurst();
        ws.send(JSON.stringify({ type: 'resync' }));
      } else {
        // Socket is closed or closing — cancel any pending reconnect timer
        // and reconnect immediately so recovery is instant.
        clearTimeout(reconnectTimer);
        connectWs();
      }
      break;
    }
  }
});

// ── Keep-Alive Web Lock ──────────────────────────────────────────────────────
// Android Chrome aggressively terminates Service Workers that have no active
// fetch events and no held Web Locks. When the SW is killed, its WebSocket
// dies silently — no onclose fires, so the main thread never gets a
// sw_disconnected message and the device plays independently with no recovery.
//
// Holding a Web Lock with an infinite promise keeps the SW alive for the
// duration of the lock. The lock is re-acquired on activate so it survives
// SW updates. This is the standard pattern for keeping a SW alive on Android.
function acquireKeepAliveLock() {
  if (!('locks' in navigator)) return;
  navigator.locks.request('cinewav-sw-keepalive', { mode: 'exclusive' }, () => {
    // Return a promise that never resolves — holds the lock indefinitely.
    return new Promise(() => {});
  });
}

// ── WebSocket Heartbeat ───────────────────────────────────────────────────────
// Send a ping every 20 seconds to keep the WebSocket connection alive through
// Android's aggressive network idle detection and NAT timeout (typically 30s).
// The DO already responds to pings with pongs which update the clock offset.
// This is separate from the keepalive interval — it fires even during the
// initial burst phase to prevent the connection from being torn down.
let heartbeatTimer = null;
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping', clientTs: Date.now() }));
    } else if (wsUrl) {
      // WebSocket died silently — reconnect immediately
      clearTimeout(reconnectTimer);
      connectWs();
    }
  }, 20000);
}

// ── Install / Activate ────────────────────────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  // Pass a never-resolving promise directly to waitUntil.
  // This is the correct pattern: the SW's activate event never "completes",
  // so Android Chrome cannot mark the SW as idle and terminate it.
  // The Web Lock is a belt-and-suspenders backup; the waitUntil is the primary.
  event.waitUntil(
    self.clients.claim().then(() => {
      acquireKeepAliveLock();
      // Return a promise that never resolves — keeps the activate event
      // permanently pending, preventing Android from garbage-collecting the SW.
      return new Promise(() => {});
    })
  );
});

// ── Fetch handler (pass-through — Vite PWA handles caching) ──────────────────
self.addEventListener('fetch', (event) => {
  // Let the Vite-generated service worker handle caching.
  // We only handle the sync logic here.
  event.respondWith(fetch(event.request));
});

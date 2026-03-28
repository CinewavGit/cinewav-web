# Cinewav Platform Compatibility Guide (v1.2)

This document details the architectural differences between iOS Safari and Android Chrome regarding Web Audio and Service Worker lifecycles, the specific fixes applied to achieve stable synchronization on both platforms, and the strict rules that must be followed in future development to maintain this stability.

## 1. Platform Differences & Challenges

Building a synchronized audio player that survives screen-off and rapid seeking requires navigating fundamentally different constraints on iOS and Android.

### iOS Safari
- **Audio Routing:** By default, Web Audio API (`AudioContext`) is routed through the ringer/ambient channel, meaning it is muted by the physical silent switch.
- **Context Creation:** `AudioContext` must be created and resumed synchronously within a user gesture handler. If there is any `await` before creation, the gesture context expires and the audio remains permanently suspended.
- **Background Execution:** iOS is relatively lenient with Service Workers but strict with audio. If the screen locks and no audio is actively playing, the audio session is interrupted.
- **Latency:** iOS has near-zero output latency for Web Audio.

### Android Chrome
- **Audio Context Suspension:** Android Chrome aggressively suspends the `AudioContext` to save power. Crucially, it accumulates state across repeated `AudioBufferSourceNode` stop/start cycles. After ~10-15 rapid seeks, the context enters a permanently broken state where it reports as 'running' but produces no audio.
- **Position Tracking:** When the `AudioContext` is suspended, `audioCtx.currentTime` freezes. Relying on it for position tracking causes massive drift calculations when the context resumes.
- **Service Worker Lifecycle:** Android Chrome aggressively terminates Service Workers that have no active fetch events or held Web Locks after ~30 seconds of idle time. When the SW is killed, its WebSocket dies silently.
- **Latency:** Requesting `latencyHint: 'playback'` introduces a large OS-level audio buffer (~200-350ms), causing audio to play late relative to the wall clock.

## 2. Fixes Applied

### iOS Stability Fixes
1. **Silent Switch Bypass:** Set `navigator.audioSession.type = 'playback'` before creating the `AudioContext` (iOS 16.4+). This routes audio through the media channel, ignoring the silent switch.
2. **Synchronous Context Creation:** `AudioContext` is created and resumed synchronously at the very start of the "Join" button click handler, before any `await` calls.
3. **Silent Keepalive Node:** A looping, silent `AudioBufferSourceNode` is kept running continuously. This keeps the audio session active and prevents iOS from interrupting the context when the screen is locked.

### Android Stability Fixes
1. **Wall-Clock Position Tracking:** `getCurrentPosition()` uses `Date.now()` instead of `audioCtx.currentTime`. `Date.now()` always advances regardless of context suspension, making position tracking immune to Android's aggressive power management.
2. **Single Persistent AudioContext:** The `AudioContext` is kept alive permanently. Seeks simply stop the old node and start a new one, avoiding the accumulated state corruption that occurs when recreating the context.
3. **Service Worker Keep-Alive:** The Service Worker is kept alive indefinitely using a never-resolving promise passed directly to `event.waitUntil()` in the `activate` handler, supplemented by an exclusive Web Lock (`navigator.locks.request`).
4. **Latency Compensation:** `audioCtx.outputLatency` and `audioCtx.baseLatency` are measured after the context starts running. This `platformLatencyMs` is added to the node start offset to compensate for Android's large playback buffer.
5. **Post-Show Polling:** When the track ends naturally (`onended`), the silent keepalive node is restarted and a 20-second polling loop is initiated. This prevents Android from detecting the end of the media session and killing the SW, ensuring the device can instantly re-sync if the master player restarts.

### Server-Side (Durable Object) Fixes
1. **Debounced Storage Writes:** Rapid seek commands no longer `await` storage writes. All `storage.put` calls are fire-and-forget to prevent Durable Object CPU budget exhaustion and WebSocket disconnection.

## 3. Rules for Future Development

To maintain cross-platform stability, the following rules **MUST NEVER** be violated:

1. **Never use `audioCtx.currentTime` for position tracking.** Always use the `Date.now()` wall-clock approach implemented in `getCurrentPosition()`.
2. **Never close or recreate the `AudioContext` during normal playback.** Keep a single context alive and manage playback by stopping and starting `AudioBufferSourceNode` instances.
3. **Never remove the `event.waitUntil(new Promise(() => {}))` from the Service Worker.** This is the only reliable way to prevent Android Chrome from killing the background sync process.
4. **Always apply `platformLatencyMs` to `node.start()`, but never to position tracking.** The latency compensation shifts the audio hardware output but must remain invisible to the master-space position calculations.
5. **Never trust local `masterIsPlaying` flags for recovery.** After a disconnect or context suspension, always request authoritative state from the server via a hard resync.
6. **Always maintain a silent keepalive node.** Whether during active playback, paused state, or after the show has ended, the silent node ensures the OS media session remains active.

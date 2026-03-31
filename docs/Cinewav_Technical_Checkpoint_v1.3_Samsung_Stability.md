# Cinewav Technical Checkpoint v1.3: Samsung Stability & Connection Gating

**Author:** Manus AI  
**Date:** March 31, 2026  
**Git Tag:** `v1.3-samsung-stable`

This document serves as the definitive technical checkpoint for the architecture changes implemented to achieve stable background audio and WebSocket synchronization on Android devices, specifically addressing the aggressive process-killing behavior of Samsung One UI. It also details the connection-state gating mechanisms that prevent independent, unsynchronized playback.

---

## 1. The Samsung Screen-Lock Kill

The most severe issue encountered on Android was that Samsung devices (running One UI) would lose synchronization within 1 to 3 seconds of the screen being locked. The device would miss all master commands (seeks, pauses) and either play independently or fall silent.

### The Root Cause: OS-Level Process Termination
Extensive research and testing revealed that Samsung One UI does not merely suspend the `AudioContext` or throttle JavaScript execution. Instead, its battery manager terminates the entire Chrome renderer process at the OS level (SIGKILL) when the screen locks, unless the app is explicitly whitelisted. 

This termination destroys the JavaScript heap, all timers, the Service Worker, the Web Lock, and the WebSocket connection simultaneously. No amount of JavaScript-level keep-alives (such as `event.waitUntil`, `navigator.locks`, or silent `AudioBufferSourceNode` loops) can prevent this OS-level action.

### The Definitive Fix: User Battery Setting
Because web applications cannot request foreground service status (like native apps such as Spotify or YouTube), the only reliable solution is a one-time user setting change. The user must instruct the Android OS that Chrome is an important background application.

**The required setting:**
`Settings → Apps → Chrome → App battery usage → Unrestricted`

To enforce this, the audience application now includes a full-screen, modal setup prompt that automatically detects Android devices via the User-Agent string. This prompt appears on the join screen before the show starts, providing step-by-step instructions to change the setting. The prompt is shown only once per device and its dismissal is recorded in `localStorage`.

---

## 2. Multi-Layered Keep-Alive Architecture

Even with the battery setting set to "Unrestricted", Android Chrome still employs aggressive network idle detection and Service Worker lifecycle management. To ensure the WebSocket and audio session survive long pauses and screen-off periods, a multi-layered keep-alive strategy is implemented.

### Layer 1: The Service Worker Web Lock
Android Chrome terminates Service Workers that have no active fetch events after approximately 30 seconds of idle time. When the Service Worker dies, its WebSocket dies silently. 
To prevent this, the Service Worker acquires an exclusive Web Lock (`navigator.locks.request`) in its `activate` handler and returns a promise that never resolves. This holds the lock indefinitely, keeping the Service Worker process alive. 

*Crucial Fix:* The never-resolving promise is executed as a fire-and-forget call *after* `self.clients.claim()` resolves. Wrapping the never-resolving promise directly in `event.waitUntil()` caused Chrome to block all subsequent page asset fetches, resulting in a white screen on fresh installs.

### Layer 2: The WebSocket Heartbeat
To prevent Android's NAT timeout and network idle detection from silently dropping the WebSocket during long pauses, the main thread runs a `bgSyncHeartbeatInterval`. Every 5 seconds, it sends a `sw_hard_resync` message to the Service Worker. This forces the Service Worker to ping the server and request a fresh authoritative state, keeping the network socket active regardless of whether the master player is currently playing or paused.

### Layer 3: The Audio Keep-Alives
To keep the OS media session active and prevent the `AudioContext` from being suspended:
- **iOS:** A looping, silent `AudioBufferSourceNode` is connected to the destination. This keeps the context running without triggering 1-second OS media interruptions.
- **Android:** An `HTMLAudioElement` plays a `silent.mp3` file in a loop at `0.001` volume. This registers directly with Android's `AudioManager` API, signaling to the OS battery manager that an active audio session is in progress.

---

## 3. Connection-State Gating (Preventing Independent Playback)

A critical bug allowed audience devices to play audio independently if they lost connection during a long master pause. When the user unlocked their phone and tapped "Play" or "Resync", the device would start playing from a stale, locally extrapolated position because it did not verify the WebSocket connection.

### The Solution: Strict Server Authority
The architecture now enforces strict connection-state gating. The application maintains a `swConnected` boolean, updated by `sw_connected` and `sw_disconnected` messages from the Service Worker.

**When Disconnected (`swConnected === false`):**
- The UI status displays "Reconnecting…".
- The Play/Pause button and Resync button are disabled.
- The OS lock-screen MediaSession play handler is intercepted and blocked.
- Local playback cannot be initiated.

**When Reconnected (`swConnected === true`):**
- The UI controls are re-enabled.
- The application *immediately* sends a `sw_hard_resync` request to the server.
- The device never guesses its position from local state; it waits for the server's `sync` reply to dictate the authoritative `masterPosition` and `isPlaying` state.

This ensures that an audience device can only ever play audio when it has a confirmed, live connection to the master player's timeline.

---

## 4. Summary of Core Rules

To maintain this stability, future development must adhere to these rules:

1. **Never bypass the connection gate.** All playback initiation must verify `swConnected` and request a fresh state from the server.
2. **Never block `event.waitUntil` in the Service Worker.** Keep-alive locks must be fire-and-forget to avoid blocking page load fetches.
3. **Maintain the Android battery prompt.** Do not remove the UI prompt; it is the only defense against Samsung's OS-level process termination.
4. **Keep the 5-second heartbeat unconditional.** The `bgSyncHeartbeat` must fire even when paused to prevent NAT timeouts during long idle periods.

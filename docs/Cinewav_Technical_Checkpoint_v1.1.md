# Cinewav Technical Checkpoint v1.1: Architecture, Fixes, and Anti-Patterns

**Author:** Manus AI  
**Date:** March 27, 2026  
**Git Tag:** `v1.1-android-wallclock`

This document serves as a definitive checkpoint for the Cinewav Web Audio sync engine. It details the core architectural decisions that achieved stability across both iOS and Android, documents the failed approaches that must not be repeated, and establishes strict rules for future development.

---

## 1. The Android Sync Loss Bug (The "Wall-Clock" Fix)

The most persistent issue during development was Android devices losing synchronization after 5 to 15 rapid playhead movements (seeks) on the master player. The device would eventually stop responding to master position updates, display massive drift (e.g., 600ms+), and either oscillate wildly or play independently.

### The Root Cause
The failure stemmed from relying on `audioCtx.currentTime` for position tracking. Android Chrome aggressively power-manages Web Audio. After repeated `AudioBufferSourceNode` stop/start cycles (which occur during rapid seeks), Android silently suspends the `AudioContext` without reliably firing a `statechange` event. 

When the context is suspended, `audioCtx.currentTime` **freezes**. Because the drift calculation relied on this frozen clock (`actualPos = playStartPos + (audioCtx.currentTime - playStartCtxTime)`), it produced wildly inaccurate drift readings the moment the context recovered. This triggered a cascade of erroneous auto-resyncs, eventually breaking the audio graph entirely.

### The Solution
The architecture was rewritten to use the **wall clock** (`Date.now()`) for position tracking instead of the Web Audio clock.

```typescript
// The stable wall-clock position calculation
function getCurrentPosition(): number {
  if (!isPlaying) return playStartPos;
  return playStartPos + (Date.now() - playStartWallTime) / 1000;
}
```

Because `Date.now()` always advances regardless of the `AudioContext` state, browser throttling, or thread suspension, the drift calculation (`actualPos - expectedPos`) remains perfectly accurate even if the audio output temporarily drops out. The `AudioContext` is now kept alive permanently, and seeks are handled synchronously by simply stopping the old node, starting a new one, and recording `playStartWallTime = Date.now()`.

---

## 2. Failed Approaches (What NOT to do)

During the investigation of the Android sync loss, several approaches were attempted and ultimately discarded. **Do not revert to these patterns.**

| Failed Approach | Why it Failed |
|---|---|
| **Explicit `suspend()` / `resume()` on seek** | Calling `audioCtx.suspend()` on pause/seek and `resume()` on play caused race conditions. On Android, `resume()` is asynchronous and can take 50–200ms. Awaiting it during a seek blocked the command queue and led to unrecoverable states if the context failed to resume. |
| **Recreating `AudioContext` on every seek** | We attempted to close and recreate the entire `AudioContext` on every seek to clear accumulated state. This introduced a massive async gap (decode + resume latency). During this gap, the drift loop would fire, see `audioCtx.currentTime` reset to 0, calculate massive drift, and trigger another recreation, resulting in an infinite oscillation loop. |
| **Trusting local `masterIsPlaying` for recovery** | Recovery paths (like the `visibilitychange` handler or health-check timer) used to check a local `masterIsPlaying` flag to decide whether to restart playback. If a `pause` command was missed while the device was suspended, the device would "ghost play" upon waking up, even if the master was paused. |

---

## 3. The iOS Stability Fixes

iOS presented its own unique set of challenges, primarily related to strict user-gesture requirements and background audio policies. The following fixes are currently active and stable:

### The Silent Switch Bypass
By default, iOS routes Web Audio API output through the "ringer/ambient" channel, meaning the physical silent switch on the side of the iPhone mutes the audio. 
**Fix:** We set `navigator.audioSession.type = 'playback'` before creating the `AudioContext`. This routes the audio through the media channel (like YouTube or Spotify), bypassing the silent switch.

### Synchronous Context Creation on Join
iOS requires the `AudioContext` to be created and resumed synchronously within a user gesture handler. 
**Fix:** The `AudioContext` is created and `resume()` is called at the very top of the "Join" button click handler, *before* any `await` calls. If placed after an `await`, the gesture context expires, and the audio remains permanently suspended.

### Background Audio Keepalive
To keep the `AudioContext` alive when the iOS screen is locked, the app must continuously play audio.
**Fix:** We use a looping `AudioBufferSourceNode` playing a silent buffer, connected directly to the destination. This keeps the context running without triggering OS-level media interruptions (which occurred when using a looping HTML `<audio>` element).

---

## 4. Core Architectural Rules (Never Revert These)

To maintain the current stability, future development must adhere to these strict rules:

1. **Never use `audioCtx.currentTime` for position tracking.** Always use `Date.now()` (the wall clock) to calculate the current playback position.
2. **Never close or recreate the `AudioContext` during normal playback.** Create it once, keep it alive, and manage playback by creating and destroying `AudioBufferSourceNode` instances.
3. **Process commands synchronously.** The `handleShowCommand` function and the command queue must remain synchronous. Do not introduce `await` gaps in the seek path, as they allow the drift loop to misfire.
4. **Recovery paths must ask the server.** When recovering from a suspended state (e.g., tab visibility change, health-check timer), never blindly restart playback based on local state. Always send a `sw_hard_resync` request to the server to get the authoritative truth.
5. **Always stamp commands on the main thread.** The Service Worker receives commands, but the main thread must stamp them with `Date.now()` (`cmd.enqueuedAt`) the moment they enter the queue. This ensures both sides of the drift calculation use the exact same clock source.

---

**End of Document**

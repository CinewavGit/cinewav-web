# Cinewav Web Architecture & Technical Summary

**Version:** v1.0-ios-stable  
**Date:** March 2026  
**Author:** Manus AI

This document provides a comprehensive technical summary of the Cinewav Web build journey up to the `v1.0-ios-stable` release. It details the core architecture, the critical synchronization mechanisms, the major bugs resolved to achieve iOS stability, and the remaining known issues on Android.

## 1. System Architecture Overview

The Cinewav Web system is designed to synchronize audio playback on thousands of audience devices with a master video player. The architecture is built on modern web technologies to ensure low latency, high scalability, and cross-platform compatibility.

### 1.1 Core Components

The system consists of three primary components:

*   **Master Player (`master/src/main.ts`):** A web interface built around an `HTMLVideoElement`. It acts as the source of truth for the show's state. When the operator plays, pauses, or seeks the video, the master player broadcasts these events via WebSocket to the server.
*   **Sync Server (`worker/src/showRoom.ts`):** A Cloudflare Durable Object that manages the authoritative state of the show. It handles WebSocket connections from the master and all audience devices, processes NTP-style ping/pong messages for clock synchronization, and broadcasts state changes (play, pause, seek) to the audience.
*   **Audience PWA (`audience/src/main.ts` & `sync-worker.js`):** A Progressive Web App that audience members use to listen to the synchronized audio. It downloads the audio file locally, maintains a synchronized clock with the server via a Service Worker, and uses the Web Audio API (`AudioContext` and `AudioBufferSourceNode`) for precise playback control.

### 1.2 Infrastructure

The application is deployed on Cloudflare's edge network:

| Component | Cloudflare Service | Purpose |
| :--- | :--- | :--- |
| **Frontend Hosting** | Cloudflare Pages | Hosts the static assets for both the Master and Audience PWAs. |
| **Sync Server** | Cloudflare Durable Objects | Provides a single, globally consistent point of coordination for each show, managing WebSocket state and broadcasting commands. |
| **Audio Storage** | Cloudflare R2 | Stores the extracted audio files for fast, globally distributed downloads to audience devices. |

## 2. Synchronization Mechanism

Achieving perfect audio sync across diverse mobile devices requires a robust, multi-layered approach to handle network latency, clock drift, and platform-specific audio quirks.

### 2.1 NTP-Style Clock Synchronization

To ensure all devices agree on when an event occurred, the system implements an NTP (Network Time Protocol) style clock synchronization.

1.  **Ping Burst:** Upon connection, the audience device sends a rapid burst of 16 `ping` messages to the server.
2.  **Pong Response:** The server replies with a `pong` containing the server's current timestamp.
3.  **Offset Calculation:** The client calculates the round-trip time (RTT) and estimates the clock offset between the device and the server: `offset = serverTs - (clientTs + rtt / 2)`.
4.  **Median Filter:** The client maintains a history of the last 16 offsets and uses the median value to filter out network jitter and anomalies, establishing a stable `clockOffsetMs`.

### 2.2 Command Transit Correction

When the master player issues a `play` command, it includes the `serverTs` of when the command was processed. The audience device uses its synchronized clock to calculate how long the message spent in transit and advances the starting playback position accordingly.

### 2.3 Continuous Drift Correction

The audience PWA runs a continuous drift detection loop (every 500ms) to ensure playback remains locked to the master.

*   **Estimated Master Position:** The client calculates where the master *should* be right now: `masterPosition + (Date.now() - masterPositionAt) / 1000`.
*   **Actual Position:** The client checks its own precise Web Audio clock: `getCurrentPosition()`.
*   **Drift Calculation:** `driftMs = (actualPos - expectedPos) * 1000`.
*   **Auto-Resync:** If the drift exceeds the defined thresholds (>150ms ahead or >300ms behind) for **two consecutive readings**, the client automatically stops and restarts playback at the newly calculated correct position. The two-reading requirement acts as a noise guard against spurious single-frame glitches.

## 3. Key Fixes for iOS Stability

Achieving the `v1.0-ios-stable` milestone required resolving several complex, platform-specific issues, particularly around iOS Safari's strict audio and background execution policies.

### 3.1 iOS Silent Switch Muting Audio

**The Problem:** On iOS, the physical silent/ringer switch mutes audio played via the Web Audio API (`AudioContext`), as it defaults to the "ambient" audio session category. Standard `<audio>` or `<video>` elements use the "playback" category and are not muted.

**The Fix:** Implemented the modern `navigator.audioSession` API (available in iOS 16.4+). By setting `navigator.audioSession.type = 'playback'` *before* creating the `AudioContext`, iOS is instructed to route the Web Audio output through the media channel, bypassing the silent switch.

### 3.2 AudioContext Suspension (Autoplay Policy)

**The Problem:** iOS requires an `AudioContext` to be created and resumed synchronously within a direct user gesture handler (e.g., a button click). The initial implementation awaited network requests before creating the context, causing the gesture context to expire and leaving the audio permanently suspended.

**The Fix:** Refactored the `joinShow()` flow. The `AudioContext` is now created and `resume()` is called synchronously at the very beginning of the "Join" button click handler, before any `await` statements.

### 3.3 Stale Manual Resync Position

**The Problem:** When a user tapped the manual "Resync" button, the server returned the raw `position` stored at the exact moment the last command (play/pause/seek) was received. If the show had been playing for 5 minutes, the server still returned the 5-minute-old position, causing all devices to jump backward.

**The Fix:** Updated the server's `resync` handler in `showRoom.ts`. When the show is playing, the server now dynamically computes the live position by adding the elapsed time since the last state update (`serverTs`) before sending the sync message to the client.

### 3.4 Async Command Race Conditions

**The Problem:** Rapid successive commands from the master (e.g., a quick seek followed immediately by play) could cause race conditions in the audience's `handleShowCommand` async function, leading to corrupted shared state (like `sourceNode` or `isPlaying`).

**The Fix:** Implemented a strict serial command queue. Commands are processed one at a time. Crucially, `pause` commands are given the highest priority and placed at the front of the queue to ensure they are never dropped, while intermediate stale `seek` or `play` commands are discarded in favor of the latest state.

### 3.5 iOS Background Audio Keepalive

**The Problem:** When an iOS device screen is locked, Safari aggressively suspends execution. Previous attempts to keep the audio session alive used a looping silent HTML `<audio>` element, but this caused the OS to register a new media event every loop, resulting in 1-second audio interruptions.

**The Fix:** Replaced the HTML audio element with a looping, silent `AudioBufferSourceNode` connected directly to the `AudioContext` destination. This keeps the Web Audio hardware active and prevents suspension without triggering OS-level media interruptions.

### 3.6 Clock Skew Between Threads

**The Problem:** The Service Worker thread (handling WebSockets) and the main thread (handling UI and drift calculation) can experience measurable clock skew on iOS, especially after screen locks. Using the Service Worker's timestamp for `masterPositionAt` caused inaccurate drift calculations.

**The Fix:** The `masterPositionAt` timestamp is now strictly recorded using `Date.now()` on the main thread at the exact moment the command is enqueued for processing, ensuring both sides of the drift calculation use the same clock reference.

## 4. Known Issues & Next Steps

While iOS is now highly stable, Android devices exhibit a specific degradation over time.

### 4.1 Android Sync Loss After Multiple Seeks

**The Issue:** On Android devices, after approximately 10 playhead movements (seeks) on the master player, the audience device eventually loses the ability to synchronize. It stops responding correctly to the master's position and begins playing independently.

**Investigation Notes:**
*   The issue appears isolated to Android; iOS handles continuous seeking without degradation.
*   It may be related to how Android Chrome handles the rapid creation and destruction of `AudioBufferSourceNode` instances during frequent seeks.
*   Resource exhaustion or garbage collection delays in the Web Audio API on Android are potential culprits.

**Next Steps:**
1.  Implement detailed logging around `AudioBufferSourceNode` lifecycle events on Android.
2.  Investigate if Android requires a different approach to stopping and disconnecting old nodes during rapid seek operations.
3.  Monitor memory usage and AudioContext state during the failure condition.

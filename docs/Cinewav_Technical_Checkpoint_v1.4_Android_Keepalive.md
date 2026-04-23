# Cinewav Sync Web — Technical Checkpoint v1.4 (Android Keepalive Fix)

## The Problem
Android devices (Samsung, Oppo Find X8 Pro, ZTE) were losing WebSocket connection after ~2–3 minutes with the screen off, despite the battery setting being set to "Unrestricted". iPhones maintained connection indefinitely.

## Root Cause Analysis
1. **AudioBufferSourceNode Invisibility:** The main show audio plays through an `AudioBufferSourceNode`. On Android, this node type is completely invisible to the OS `AudioManager`. The OS does not consider the browser to be playing media.
2. **Keepalive Audio Deprioritisation:** The previous Android keepalive used a 1-second `silent.mp3` file playing in a loop via an `HTMLAudioElement` at volume `0.001`.
   - Android's `AudioManager` likely detected the 1-second looping file as a notification/ringtone sound rather than a continuous media stream, and deprioritised it after a few minutes.
   - The volume `0.001` may have been detected as effectively silent, causing the OS to remove audio focus.

## The Fix
The `HTMLAudioElement` keepalive on Android has been robustified to ensure the OS `AudioManager` treats it as a legitimate, continuous media stream:

1. **Longer Audio File:** Replaced the 1-second `silent.mp3` with a 60-second `silent60.mp3` (generated via ffmpeg). A longer file looks like genuine media streaming to the OS.
2. **Increased Volume:** Increased the volume from `0.001` to `0.01`. This is still completely inaudible through headphones at normal listening levels, but is non-trivially non-zero to the OS silence detection algorithms.
3. **MediaSession Metadata:** Added `navigator.mediaSession.metadata` to the keepalive element. This explicitly tells Android's `AudioManager` that this is a legitimate media session (like Spotify), not a background process trying to sneak audio.
4. **Element Attributes:** Added `crossOrigin="anonymous"`, `preload="auto"`, and `playsInline=true` to prevent Android from treating the audio element as a deferred or lazy resource.
5. **Autoplay Bypass:** Added a `muted = true` before `.play()`, followed by `muted = false` in the `.then()` block. This is a known trick to bypass autoplay restrictions on some strict Android versions.

## Code Changes
- Generated `/home/ubuntu/cinewav-web/audience/public/silent60.mp3`
- Updated `startAndroidKeepalive()` in `/home/ubuntu/cinewav-web/audience/src/main.ts`

## Next Steps
- User testing is required to confirm that Samsung, Oppo, and ZTE devices now survive the full 2-hour movie with screens off.
- If the issue persists, the next architectural step is to route the main show audio itself through an `HTMLAudioElement` using `createMediaElementSource()` on Android, which is a more complex change but guarantees OS-level media session registration.

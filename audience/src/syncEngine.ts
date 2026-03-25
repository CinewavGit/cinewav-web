/**
 * Cinewav Sync Engine
 *
 * Implements NTP-style clock synchronisation over WebSocket.
 *
 * Algorithm:
 *  1. On connect, fire a rapid BURST of BURST_COUNT pings spaced BURST_INTERVAL_MS
 *     apart. This quickly fills the offset history with high-quality samples before
 *     any audio starts, averaging out asymmetric network paths.
 *  2. After the burst, switch to slow KEEPALIVE pings every KEEPALIVE_INTERVAL_MS
 *     to maintain the estimate and detect long-term drift.
 *  3. Each pong: RTT = now - clientTs; offset = serverTs - (clientTs + RTT/2)
 *  4. RTT outlier rejection: discard samples where RTT > median(RTT) * RTT_OUTLIER_FACTOR
 *     (catches the occasional queued/delayed packet that would skew the estimate).
 *  5. Rolling median of the last OFFSET_HISTORY_SIZE accepted samples.
 *     Median is more robust than mean against the remaining outliers.
 *
 * Drift detection:
 *  - Every DRIFT_CHECK_INTERVAL_MS, compare expected audio position
 *    (derived from last sync command + elapsed time) with actual audio position.
 *  - If drift > RESYNC_AHEAD_MS (150ms) or drift < -RESYNC_BEHIND_MS (300ms),
 *    trigger a resync by seeking the audio buffer.
 */

export interface SyncState {
  clockOffsetMs: number;   // our estimate of (serverClock - clientClock)
  rttMs: number;
  driftMs: number;         // current audio drift in ms (positive = we're ahead)
  resyncs: number;
  lastSyncTs: number;
  burstComplete: boolean;  // true once the startup burst has finished
}

export interface ShowCommand {
  action: 'play' | 'pause' | 'seek' | 'load';
  position: number;        // seconds
  masterTs: number;        // master's audioCtx.currentTime when command was issued
  serverTs: number;        // server wall-clock ms when command was broadcast
  audioFile?: string;
}

type OnResync = (targetPosition: number, play: boolean) => void;
type OnStateChange = (state: SyncState) => void;

// ── Tuning constants ──────────────────────────────────────────────────────────

/** Number of rapid pings fired at startup to seed the offset estimate. */
const BURST_COUNT = 12;
/** Gap between burst pings in ms. 80ms gives ~1 second total burst time. */
const BURST_INTERVAL_MS = 80;
/** Slow keepalive ping interval after burst completes. */
const KEEPALIVE_INTERVAL_MS = 5000;
/** How often to check for audio drift. */
const DRIFT_CHECK_INTERVAL_MS = 500;
/** Resync if audience is more than this many ms AHEAD of master. */
const RESYNC_AHEAD_MS = 150;
/** Resync if audience is more than this many ms BEHIND master. */
const RESYNC_BEHIND_MS = 300;
/** Rolling median window size. Larger = more stable but slower to adapt. */
const OFFSET_HISTORY_SIZE = 16;
/** RTT history window for outlier detection. */
const RTT_HISTORY_SIZE = 8;
/** Discard a ping sample if its RTT is more than this multiple of the median RTT. */
const RTT_OUTLIER_FACTOR = 2.5;

export class SyncEngine {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;

  private offsetHistory: number[] = [];
  private rttHistory: number[] = [];
  private clockOffsetMs = 0;
  private rttMs = 0;
  private driftMs = 0;
  private resyncs = 0;
  private burstComplete = false;
  private burstSent = 0;

  // Last known show command from master
  private lastCommand: ShowCommand | null = null;
  // Wall-clock time (ms) when we applied the last command
  private commandAppliedAt = 0;
  // Whether we are currently in a "playing" state
  private isPlaying = false;
  // Current audio position at time of last command application
  private positionAtCommand = 0;

  private onResync: OnResync;
  private onStateChange: OnStateChange;
  private onShowCommand: ((cmd: ShowCommand) => void) | null = null;
  private onAudienceCount: ((count: number) => void) | null = null;
  private onAudioReady: ((filename: string, hash: string) => void) | null = null;

  constructor(onResync: OnResync, onStateChange: OnStateChange) {
    this.onResync = onResync;
    this.onStateChange = onStateChange;
  }

  setShowCommandHandler(fn: (cmd: ShowCommand) => void) {
    this.onShowCommand = fn;
  }

  setAudienceCountHandler(fn: (count: number) => void) {
    this.onAudienceCount = fn;
  }

  setAudioReadyHandler(fn: (filename: string, hash: string) => void) {
    this.onAudioReady = fn;
  }

  connect(wsUrl: string, showId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.disconnect();
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.ws!.send(JSON.stringify({
          type: 'join',
          role: 'audience',
          clientId: `audience-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        }));
        this.startBurst();
        this.startDriftCheckLoop();
        resolve();
      };

      this.ws.onmessage = (event) => {
        try {
          this.handleMessage(JSON.parse(event.data));
        } catch { /* ignore parse errors */ }
      };

      this.ws.onerror = () => reject(new Error('WebSocket connection failed'));
      this.ws.onclose = () => {
        this.stopTimers();
        // Reset burst state so reconnect fires a fresh burst
        this.burstComplete = false;
        this.burstSent = 0;
        // Attempt reconnect after 3 seconds
        setTimeout(() => {
          if (this.ws?.readyState === WebSocket.CLOSED) {
            this.connect(wsUrl, showId).catch(() => {});
          }
        }, 3000);
      };
    });
  }

  disconnect() {
    this.stopTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Called by the audio engine to report the current actual playback position.
   * Used for drift calculation.
   */
  reportActualPosition(actualPositionSeconds: number) {
    if (!this.isPlaying || !this.lastCommand) return;

    const elapsedMs = Date.now() - this.commandAppliedAt;
    const expectedPosition = this.positionAtCommand + elapsedMs / 1000;
    this.driftMs = (actualPositionSeconds - expectedPosition) * 1000;
    this.emitState();
  }

  /**
   * Notify the sync engine that a command has been applied
   * (so it can track expected position).
   */
  notifyCommandApplied(position: number, playing: boolean) {
    this.positionAtCommand = position;
    this.commandAppliedAt = Date.now();
    this.isPlaying = playing;
  }

  getClockOffset(): number {
    return this.clockOffsetMs;
  }

  /**
   * Returns the estimated current master playback position in seconds,
   * based on the last received command plus elapsed time.
   * Returns null if no command has been received yet.
   */
  getEstimatedMasterPosition(): number | null {
    if (!this.lastCommand) return null;
    if (!this.isPlaying) return this.lastCommand.position;
    const elapsedSec = (Date.now() - this.commandAppliedAt) / 1000;
    return this.positionAtCommand + elapsedSec;
  }

  /** Returns whether the master is currently in a playing state. */
  getIsPlaying(): boolean {
    return this.isPlaying;
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  /**
   * Fire a rapid burst of pings to seed the clock offset estimate quickly.
   * After BURST_COUNT pings, switch to slow keepalive pings.
   */
  private startBurst() {
    this.burstSent = 0;
    this.burstComplete = false;

    const firePing = () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping', clientTs: Date.now() }));
      }
      this.burstSent++;
      if (this.burstSent >= BURST_COUNT) {
        // Burst complete — switch to slow keepalive
        this.burstComplete = true;
        this.startKeepalive();
      } else {
        this.pingTimer = setTimeout(firePing, BURST_INTERVAL_MS) as unknown as ReturnType<typeof setInterval>;
      }
    };

    firePing();
  }

  private startKeepalive() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping', clientTs: Date.now() }));
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private startDriftCheckLoop() {
    this.driftTimer = setInterval(() => {
      if (!this.isPlaying || !this.lastCommand) return;

      const drift = this.driftMs;
      if (drift > RESYNC_AHEAD_MS || drift < -RESYNC_BEHIND_MS) {
        // Calculate where we should be right now
        const elapsedMs = Date.now() - this.commandAppliedAt;
        const targetPosition = this.positionAtCommand + elapsedMs / 1000;
        this.resyncs++;
        this.onResync(targetPosition, this.isPlaying);
        // Reset drift tracking after resync
        this.notifyCommandApplied(targetPosition, this.isPlaying);
        this.emitState();
      }
    }, DRIFT_CHECK_INTERVAL_MS);
  }

  private stopTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.driftTimer) { clearInterval(this.driftTimer); this.driftTimer = null; }
  }

  private handleMessage(msg: Record<string, unknown>) {
    switch (msg.type) {
      case 'pong': {
        const clientTs = msg.clientTs as number;
        const serverTs = msg.serverTs as number;
        const now = Date.now();
        const rtt = now - clientTs;

        // RTT outlier rejection: if we have enough history and this RTT is
        // suspiciously high (e.g. a queued/retransmitted packet), discard it.
        if (this.rttHistory.length >= 4) {
          const sortedRtt = [...this.rttHistory].sort((a, b) => a - b);
          const medianRtt = sortedRtt[Math.floor(sortedRtt.length / 2)];
          if (rtt > medianRtt * RTT_OUTLIER_FACTOR) {
            // Outlier — update RTT display but don't use this offset sample
            this.rttMs = rtt;
            this.emitState();
            break;
          }
        }

        // Accept this sample
        this.rttMs = rtt;
        this.addRttSample(rtt);

        const offset = serverTs - (clientTs + rtt / 2);
        this.addOffsetSample(offset);
        this.emitState();
        break;
      }

      case 'welcome':
      case 'sync': {
        const cmd: ShowCommand = {
          action: (msg.action || (msg.isPlaying ? 'play' : 'pause')) as ShowCommand['action'],
          position: (msg.position as number) || 0,
          masterTs: (msg.masterTs as number) || 0,
          serverTs: (msg.serverTs as number) || Date.now(),
          audioFile: msg.audioFile as string | undefined,
        };

        // Adjust position for network latency:
        // The command was sent at serverTs. It arrived now.
        // Use the clock-offset-corrected transit time.
        const transitMs = (Date.now() - cmd.serverTs) - this.clockOffsetMs;
        if (cmd.action === 'play') {
          cmd.position += Math.max(0, transitMs) / 1000;
        }

        this.lastCommand = cmd;
        this.isPlaying = cmd.action === 'play';
        if (this.onShowCommand) this.onShowCommand(cmd);
        break;
      }

      case 'audience_count': {
        if (this.onAudienceCount) this.onAudienceCount(msg.count as number);
        break;
      }

      case 'audio_ready': {
        if (this.onAudioReady) {
          this.onAudioReady(msg.audioFile as string, msg.audioHash as string);
        }
        break;
      }
    }
  }

  private addRttSample(rtt: number) {
    this.rttHistory.push(rtt);
    if (this.rttHistory.length > RTT_HISTORY_SIZE) {
      this.rttHistory.shift();
    }
  }

  private addOffsetSample(offset: number) {
    this.offsetHistory.push(offset);
    if (this.offsetHistory.length > OFFSET_HISTORY_SIZE) {
      this.offsetHistory.shift();
    }
    // Use median for stability (resistant to remaining outliers)
    const sorted = [...this.offsetHistory].sort((a, b) => a - b);
    this.clockOffsetMs = sorted[Math.floor(sorted.length / 2)];
  }

  private emitState() {
    this.onStateChange({
      clockOffsetMs: this.clockOffsetMs,
      rttMs: this.rttMs,
      driftMs: this.driftMs,
      resyncs: this.resyncs,
      lastSyncTs: Date.now(),
      burstComplete: this.burstComplete,
    });
  }
}

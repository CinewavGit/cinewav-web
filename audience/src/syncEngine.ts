/**
 * Cinewav Sync Engine
 *
 * Implements NTP-style clock synchronisation over WebSocket.
 *
 * Algorithm:
 *  1. Every PING_INTERVAL ms, send { type: "ping", clientTs: Date.now() }
 *  2. Server responds with { type: "pong", clientTs, serverTs }
 *  3. RTT = Date.now() - clientTs
 *  4. Clock offset = serverTs - (clientTs + RTT/2)
 *     → positive offset means server clock is ahead of client clock
 *  5. We keep a rolling median of the last N offsets for stability
 *
 * Drift detection:
 *  - Every DRIFT_CHECK_INTERVAL ms, compare expected audio position
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

const PING_INTERVAL_MS = 2000;
const DRIFT_CHECK_INTERVAL_MS = 500;
const RESYNC_AHEAD_MS = 150;    // resync if we're >150ms ahead of master
const RESYNC_BEHIND_MS = 300;   // resync if we're >300ms behind master
const OFFSET_HISTORY_SIZE = 8;  // rolling median window

export class SyncEngine {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;

  private offsetHistory: number[] = [];
  private clockOffsetMs = 0;
  private rttMs = 0;
  private driftMs = 0;
  private resyncs = 0;

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
        this.startPingLoop();
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

  // ── Private ──────────────────────────────────────────────────────────────────

  private handleMessage(msg: Record<string, unknown>) {
    switch (msg.type) {
      case 'pong': {
        const clientTs = msg.clientTs as number;
        const serverTs = msg.serverTs as number;
        const now = Date.now();
        const rtt = now - clientTs;
        this.rttMs = rtt;
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
        // Transit time = (Date.now() - serverTs) - clockOffset
        // But we already account for clock offset, so:
        const transitMs = (Date.now() - cmd.serverTs) - this.clockOffsetMs;
        if (cmd.action === 'play') {
          // Advance position by transit time so we start at the right spot
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
    }
  }

  private startPingLoop() {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping', clientTs: Date.now() }));
      }
    }, PING_INTERVAL_MS);
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
        // Reset drift after resync
        this.notifyCommandApplied(targetPosition, this.isPlaying);
        this.emitState();
      }
    }, DRIFT_CHECK_INTERVAL_MS);
  }

  private stopTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.driftTimer) { clearInterval(this.driftTimer); this.driftTimer = null; }
  }

  private addOffsetSample(offset: number) {
    this.offsetHistory.push(offset);
    if (this.offsetHistory.length > OFFSET_HISTORY_SIZE) {
      this.offsetHistory.shift();
    }
    // Use median for stability (resistant to outliers)
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
    });
  }
}

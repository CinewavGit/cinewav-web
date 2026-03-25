/**
 * Cinewav Sync Engine v3
 *
 * NTP-style clock synchronisation over WebSocket.
 *
 * Clock offset formula:
 *   offset = serverTs - (clientTs + rtt/2)
 *   meaning: serverClock = clientClock + offset
 *   so:      clientClock = serverClock - offset
 *
 * To convert a server timestamp to local time:  serverTs - offset
 * To convert local time to server time:         localTs  + offset
 *
 * Transit correction (how far the master has moved since sending a command):
 *   transitSec = ((Date.now() + clockOffsetMs) - cmd.serverTs) / 1000
 *   correctedPosition = cmd.position + transitSec
 *
 * Drift detection:
 *   Every 500ms compare actual audio position with expected position.
 *   Expected = positionAtCommand + (Date.now() - commandAppliedAt) / 1000
 *   Resync if drift > 150ms ahead or > 300ms behind.
 */

export interface SyncState {
  clockOffsetMs: number;
  rttMs: number;
  driftMs: number;
  resyncs: number;
  lastSyncTs: number;
  burstComplete: boolean;
}

export interface ShowCommand {
  action: 'play' | 'pause' | 'seek' | 'load';
  position: number;       // seconds — already transit-corrected
  masterTs: number;
  serverTs: number;       // server wall-clock ms when command was broadcast
  audioFile?: string;
  receivedAt: number;     // client wall-clock ms when we received this message
}

type OnResync = (targetPosition: number, play: boolean) => void;
type OnStateChange = (state: SyncState) => void;

const BURST_COUNT         = 12;
const BURST_INTERVAL_MS   = 80;
const KEEPALIVE_INTERVAL_MS = 5000;
const DRIFT_CHECK_INTERVAL_MS = 500;
const RESYNC_AHEAD_MS     = 150;
const RESYNC_BEHIND_MS    = 300;
const OFFSET_HISTORY_SIZE = 16;
const RTT_HISTORY_SIZE    = 8;
const RTT_OUTLIER_FACTOR  = 2.5;

export class SyncEngine {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;

  private offsetHistory: number[] = [];
  private rttHistory: number[]    = [];
  private clockOffsetMs = 0;
  private rttMs         = 0;
  private driftMs       = 0;
  private resyncs       = 0;
  private burstComplete = false;
  private burstSent     = 0;

  // Tracking for drift detection
  private isPlaying        = false;
  private positionAtCommand = 0;
  private commandAppliedAt  = 0;   // local Date.now() when we applied the command
  private lastCommand: ShowCommand | null = null;

  private onResync:      OnResync;
  private onStateChange: OnStateChange;
  private onShowCommand: ((cmd: ShowCommand) => void) | null = null;
  private onAudienceCount: ((count: number) => void) | null = null;
  private onAudioReady: ((filename: string, hash: string) => void) | null = null;

  constructor(onResync: OnResync, onStateChange: OnStateChange) {
    this.onResync      = onResync;
    this.onStateChange = onStateChange;
  }

  setShowCommandHandler(fn: (cmd: ShowCommand) => void)          { this.onShowCommand    = fn; }
  setAudienceCountHandler(fn: (count: number) => void)           { this.onAudienceCount  = fn; }
  setAudioReadyHandler(fn: (filename: string, hash: string) => void) { this.onAudioReady = fn; }

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
        try { this.handleMessage(JSON.parse(event.data)); } catch { /* ignore */ }
      };

      this.ws.onerror = () => reject(new Error('WebSocket connection failed'));

      this.ws.onclose = () => {
        this.stopTimers();
        this.burstComplete = false;
        this.burstSent     = 0;
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

  /** Called by audio engine after applying a command so drift tracking is accurate. */
  notifyCommandApplied(position: number, playing: boolean) {
    this.positionAtCommand = position;
    this.commandAppliedAt  = Date.now();
    this.isPlaying         = playing;
  }

  /** Called by UI loop to report actual audio position for drift calculation. */
  reportActualPosition(actualSec: number) {
    if (!this.isPlaying || !this.lastCommand) return;
    const expectedSec = this.positionAtCommand + (Date.now() - this.commandAppliedAt) / 1000;
    this.driftMs = (actualSec - expectedSec) * 1000;
    this.emitState();
  }

  getClockOffset(): number { return this.clockOffsetMs; }
  getIsPlaying(): boolean  { return this.isPlaying; }

  /**
   * Estimate where the master is RIGHT NOW.
   * Uses commandAppliedAt (local clock) so it stays accurate even if
   * the master hasn't sent a new command recently.
   */
  getEstimatedMasterPosition(): number | null {
    if (!this.lastCommand) return null;
    if (!this.isPlaying)   return this.lastCommand.position;
    const elapsedSec = (Date.now() - this.commandAppliedAt) / 1000;
    return this.positionAtCommand + elapsedSec;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private startBurst() {
    this.burstSent     = 0;
    this.burstComplete = false;

    const firePing = () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping', clientTs: Date.now() }));
      }
      this.burstSent++;
      if (this.burstSent >= BURST_COUNT) {
        this.burstComplete = true;
        this.startKeepalive();
      } else {
        this.pingTimer = setTimeout(firePing, BURST_INTERVAL_MS);
      }
    };
    firePing();
  }

  private startKeepalive() {
    if (this.pingTimer) { clearTimeout(this.pingTimer); this.pingTimer = null; }
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping', clientTs: Date.now() }));
      }
    }, KEEPALIVE_INTERVAL_MS) as unknown as ReturnType<typeof setTimeout>;
  }

  private startDriftCheckLoop() {
    this.driftTimer = setInterval(() => {
      if (!this.isPlaying || !this.lastCommand) return;
      if (this.driftMs > RESYNC_AHEAD_MS || this.driftMs < -RESYNC_BEHIND_MS) {
        const targetPos = this.positionAtCommand + (Date.now() - this.commandAppliedAt) / 1000;
        this.resyncs++;
        this.onResync(targetPos, true);
        this.notifyCommandApplied(targetPos, true);
        this.emitState();
      }
    }, DRIFT_CHECK_INTERVAL_MS);
  }

  private stopTimers() {
    if (this.pingTimer)  { clearTimeout(this.pingTimer as ReturnType<typeof setTimeout>);  this.pingTimer  = null; }
    if (this.driftTimer) { clearInterval(this.driftTimer); this.driftTimer = null; }
  }

  private handleMessage(msg: Record<string, unknown>) {
    switch (msg.type) {

      case 'pong': {
        const clientTs = msg.clientTs as number;
        const serverTs = msg.serverTs as number;
        const now      = Date.now();
        const rtt      = now - clientTs;

        // Outlier rejection
        if (this.rttHistory.length >= 4) {
          const sorted    = [...this.rttHistory].sort((a, b) => a - b);
          const medianRtt = sorted[Math.floor(sorted.length / 2)];
          if (rtt > medianRtt * RTT_OUTLIER_FACTOR) {
            this.rttMs = rtt;
            this.emitState();
            break;
          }
        }

        this.rttMs = rtt;
        this.addRttSample(rtt);
        // offset = serverClock - clientClock
        // so: serverTime = clientTime + offset
        const offset = serverTs - (clientTs + rtt / 2);
        this.addOffsetSample(offset);
        this.emitState();
        break;
      }

      case 'welcome':
      case 'sync': {
        const receivedAt = Date.now();
        const rawPosition = (msg.position as number) || 0;
        const serverTs    = (msg.serverTs as number) || receivedAt;
        const action      = (msg.action || (msg.isPlaying ? 'play' : 'pause')) as ShowCommand['action'];

        // Transit correction:
        // serverNow  = clientNow + clockOffsetMs
        // transitMs  = serverNow - serverTs  (how long since command was sent)
        // FIX: was subtracting offset in wrong direction in previous version
        let correctedPosition = rawPosition;
        if (action === 'play') {
          const serverNow  = receivedAt + this.clockOffsetMs;
          const transitMs  = Math.max(0, serverNow - serverTs);
          correctedPosition = rawPosition + transitMs / 1000;
        }

        const cmd: ShowCommand = {
          action,
          position:   correctedPosition,
          masterTs:   (msg.masterTs as number) || 0,
          serverTs,
          audioFile:  msg.audioFile as string | undefined,
          receivedAt,
        };

        this.lastCommand = cmd;
        this.isPlaying   = (action === 'play');

        // commandAppliedAt is set here so getEstimatedMasterPosition() works
        // immediately, even before the audio engine calls notifyCommandApplied().
        // The audio engine will overwrite this with a more precise value.
        this.positionAtCommand = correctedPosition;
        this.commandAppliedAt  = receivedAt;

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
    if (this.rttHistory.length > RTT_HISTORY_SIZE) this.rttHistory.shift();
  }

  private addOffsetSample(offset: number) {
    this.offsetHistory.push(offset);
    if (this.offsetHistory.length > OFFSET_HISTORY_SIZE) this.offsetHistory.shift();
    const sorted = [...this.offsetHistory].sort((a, b) => a - b);
    this.clockOffsetMs = sorted[Math.floor(sorted.length / 2)];
  }

  private emitState() {
    this.onStateChange({
      clockOffsetMs: this.clockOffsetMs,
      rttMs:         this.rttMs,
      driftMs:       this.driftMs,
      resyncs:       this.resyncs,
      lastSyncTs:    Date.now(),
      burstComplete: this.burstComplete,
    });
  }
}

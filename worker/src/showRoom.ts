/**
 * ShowRoom — Cloudflare Durable Object
 *
 * One instance per show/event. Manages:
 *  - WebSocket connections for master and all audience devices
 *  - NTP-style clock synchronisation (ping/pong)
 *  - Show state (play/pause/seek position)
 *  - Drift detection and resync broadcasts
 *
 * WebSocket message protocol (JSON):
 *
 *  Client → Server:
 *    { type: "join",   role: "master"|"audience", clientId: string }
 *    { type: "ping",   clientId: string, clientTs: number }
 *    { type: "command", action: "play"|"pause"|"seek", position: number, masterTs: number }
 *    { type: "leave",  clientId: string }
 *
 *  Server → Client:
 *    { type: "pong",   clientId: string, clientTs: number, serverTs: number }
 *    { type: "sync",   action: "play"|"pause"|"seek", position: number, masterTs: number, serverTs: number }
 *    { type: "state",  ...ShowState }
 *    { type: "welcome", clientId: string, role: string, ...ShowState }
 *    { type: "audience_count", count: number }
 */

export interface ShowState {
  isPlaying: boolean;
  position: number;       // seconds from start
  masterTs: number;       // master's audio context time when position was set
  serverTs: number;       // server wall-clock ms when state was last updated
  audioFile: string | null;  // display filename
  audioHash: string | null;  // hash of audio file — audience uses this to detect changes
  audioReady: boolean;       // true once audio has been uploaded to R2
  showId: string;
}

interface ConnectedClient {
  ws: WebSocket;
  role: 'master' | 'audience';
  clientId: string;
  joinedAt: number;
}

export class ShowRoom {
  private state: DurableObjectState;
  private clients: Map<string, ConnectedClient> = new Map();
  private showState: ShowState = {
    isPlaying: false,
    position: 0,
    masterTs: 0,
    serverTs: 0,
    audioFile: null,
    audioHash: null,
    audioReady: false,
    showId: '',
  };

  constructor(state: DurableObjectState) {
    this.state = state;
    // Restore persisted show state on wake-up
    this.state.blockConcurrencyWhile(async () => {
      const saved = await this.state.storage.get<ShowState>('showState');
      if (saved) {
        this.showState = saved;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract showId from path: /api/show/:showId/...
    const showMatch = url.pathname.match(/^\/api\/show\/([^/]+)(\/.*)?$/);
    const showId = showMatch ? showMatch[1] : 'unknown';
    this.showState.showId = showId;

    const subPath = showMatch ? (showMatch[2] || '/') : '/';

    // ── WebSocket upgrade ──────────────────────────────────────────────────
    if (subPath === '/ws') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // Use Hibernation API so idle connections don't bill compute
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // ── REST: GET /state ───────────────────────────────────────────────────
    if (subPath === '/state' && request.method === 'GET') {
      return new Response(JSON.stringify(this.showState), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── REST: POST /audio-ready (internal — called by Worker after R2 upload) ─────
    if (subPath === '/audio-ready' && request.method === 'POST') {
      const body = await request.json<{ filename: string; hash: string }>();
      this.showState.audioFile = body.filename;
      this.showState.audioHash = body.hash;
      this.showState.audioReady = true;
      this.showState.serverTs = Date.now();
      await this.state.storage.put('showState', this.showState);
      // Broadcast audio-ready to all connected clients so they start downloading
      const msg = JSON.stringify({
        type: 'audio_ready',
        audioFile: body.filename,
        audioHash: body.hash,
      });
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(msg); } catch { /* ignore */ }
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── REST: POST /command (master only, fallback for non-WS clients) ─────
    if (subPath === '/command' && request.method === 'POST') {
      const body = await request.json<{ action: string; position: number; masterTs: number; audioFile?: string }>();
      await this.applyCommand(body.action, body.position, body.masterTs, body.audioFile);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── REST: POST /ping (NTP clock sync via HTTP, fallback) ───────────────
    if (subPath === '/ping' && request.method === 'POST') {
      const body = await request.json<{ clientId: string; clientTs: number }>();
      return new Response(
        JSON.stringify({ clientId: body.clientId, clientTs: body.clientTs, serverTs: Date.now() }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not Found', { status: 404 });
  }

  // ── WebSocket Hibernation Handlers ─────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    const type = msg.type as string;

    switch (type) {
      case 'join': {
        const clientId = (msg.clientId as string) || crypto.randomUUID();
        const role = (msg.role as string) === 'master' ? 'master' : 'audience';
        // Store client metadata on the WebSocket attachment (survives hibernation)
        this.state.getWebSockets().forEach((s) => {
          if (s === ws) {
            ws.serializeAttachment({ clientId, role });
          }
        });
        this.clients.set(clientId, { ws, role, clientId, joinedAt: Date.now() });
        // Send welcome with current show state
        ws.send(JSON.stringify({
          type: 'welcome',
          clientId,
          role,
          ...this.showState,
        }));
        // Broadcast updated audience count
        this.broadcastAudienceCount();
        break;
      }

      case 'ping': {
        // NTP-style: echo back client timestamp + server timestamp
        // Client calculates: offset = ((serverTs - clientTs) - (receiveTs - sendTs)) / 2
        ws.send(JSON.stringify({
          type: 'pong',
          clientId: msg.clientId,
          clientTs: msg.clientTs,
          serverTs: Date.now(),
        }));
        break;
      }

      case 'command': {
        // Only master can send commands
        const attachment = ws.deserializeAttachment() as { role?: string } | null;
        if (!attachment || attachment.role !== 'master') {
          ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: only master can send commands' }));
          return;
        }
        const action = msg.action as string;
        const position = (msg.position as number) || 0;
        const masterTs = (msg.masterTs as number) || Date.now();
        const audioFile = msg.audioFile as string | undefined;
        await this.applyCommand(action, position, masterTs, audioFile);
        break;
      }

      case 'resync': {
        // Audience client requesting fresh authoritative state
        // Reply with a sync message containing current show state
        ws.send(JSON.stringify({
          type:      'sync',
          action:    this.showState.isPlaying ? 'play' : 'pause',
          position:  this.showState.position,
          masterTs:  this.showState.masterTs,
          serverTs:  Date.now(),
          audioFile: this.showState.audioFile,
        }));
        break;
      }

      case 'leave': {
        const attachment = ws.deserializeAttachment() as { clientId?: string } | null;
        if (attachment?.clientId) {
          this.clients.delete(attachment.clientId);
        }
        this.broadcastAudienceCount();
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${type}` }));
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    const attachment = ws.deserializeAttachment() as { clientId?: string } | null;
    if (attachment?.clientId) {
      this.clients.delete(attachment.clientId);
    }
    this.broadcastAudienceCount();
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const attachment = ws.deserializeAttachment() as { clientId?: string } | null;
    if (attachment?.clientId) {
      this.clients.delete(attachment.clientId);
    }
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  private async applyCommand(
    action: string,
    position: number,
    masterTs: number,
    audioFile?: string
  ): Promise<void> {
    const serverTs = Date.now();

    if (action === 'play') {
      this.showState.isPlaying = true;
      this.showState.position = position;
      this.showState.masterTs = masterTs;
      this.showState.serverTs = serverTs;
    } else if (action === 'pause') {
      this.showState.isPlaying = false;
      this.showState.position = position;
      this.showState.masterTs = masterTs;
      this.showState.serverTs = serverTs;
    } else if (action === 'seek') {
      this.showState.position = position;
      this.showState.masterTs = masterTs;
      this.showState.serverTs = serverTs;
    } else if (action === 'load') {
      this.showState.audioFile = audioFile || null;
      this.showState.isPlaying = false;
      this.showState.position = 0;
      this.showState.masterTs = masterTs;
      this.showState.serverTs = serverTs;
      // Note: audioHash and audioReady are set separately via /audio-ready
    }

    // Persist state so it survives Durable Object hibernation
    await this.state.storage.put('showState', this.showState);

    // Broadcast sync message to all connected audience clients
    const syncMsg = JSON.stringify({
      type: 'sync',
      action,
      position: this.showState.position,
      masterTs: this.showState.masterTs,
      serverTs,
      audioFile: this.showState.audioFile,
    });

    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as { role?: string } | null;
      // Send to audience only (master already knows its own state)
      if (attachment?.role === 'audience') {
        try {
          ws.send(syncMsg);
        } catch {
          // Client disconnected — ignore
        }
      }
    }
  }

  private broadcastAudienceCount(): void {
    const sockets = this.state.getWebSockets();
    let audienceCount = 0;
    for (const ws of sockets) {
      const a = ws.deserializeAttachment() as { role?: string } | null;
      if (a?.role === 'audience') audienceCount++;
    }
    const msg = JSON.stringify({ type: 'audience_count', count: audienceCount });
    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch {
        // ignore
      }
    }
  }
}

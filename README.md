# Cinewav Web — Synchronized Cinema Audio System

A fully web-based, real-time synchronized audio system for live cinema events. A **Master Player** on a PC or iPad controls playback; thousands of **Audience devices** follow in perfect sync, playing a locally stored audio file through their headphones while watching the projected visuals.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE EDGE NETWORK                      │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │          Sync Worker (Cloudflare Workers)                │   │
│  │                                                          │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │   ShowRoom Durable Object (per show)            │    │   │
│  │  │   • Manages all WebSocket connections           │    │   │
│  │  │   • NTP ping/pong clock sync                    │    │   │
│  │  │   • Broadcasts play/pause/seek to audience      │    │   │
│  │  │   • Persists show state across hibernation      │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  │                                                          │   │
│  │  REST endpoints:                                         │   │
│  │    GET  /api/health                                      │   │
│  │    GET  /api/show/:id/state                              │   │
│  │    POST /api/show/:id/command  (play/pause/seek/load)    │   │
│  │    POST /api/show/:id/ping     (NTP fallback)            │   │
│  │    GET  /api/show/:id/ws       (WebSocket upgrade)       │   │
│  │    GET  /api/show/:id/audio    (R2 audio proxy)          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌────────────────────┐    ┌────────────────────────────────┐   │
│  │  Master App        │    │  Audience PWA                  │   │
│  │  (Pages)           │    │  (Pages)                       │   │
│  │  cinewav-master    │    │  cinewav-audience              │   │
│  │  .pages.dev        │    │  .pages.dev                    │   │
│  └────────────────────┘    └────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

Master Player ──WebSocket──▶ ShowRoom DO ──broadcast──▶ Audience (×10,000)
```

---

## Sync Algorithm

### Clock Synchronisation (NTP-style)

Every 2 seconds, each audience device performs a round-trip measurement:

```
Client sends:  { type: "ping", clientTs: T0 }
Server sends:  { type: "pong", clientTs: T0, serverTs: T1 }
Client receives at: T2

RTT           = T2 - T0
Clock offset  = T1 - (T0 + RTT/2)
```

The client keeps a rolling median of the last 8 offset measurements, making the estimate resistant to network jitter. This offset is used to compensate for the difference between the client's local clock and the server's clock.

### Drift Detection and Correction

Every 500ms, the audience device compares:
- **Expected position**: `positionAtLastCommand + elapsedTimeSinceCommand`
- **Actual position**: reported by the Web Audio API

| Drift Condition | Action |
|:---|:---|
| Drift > **+150ms** (ahead of master) | Seek forward to correct position |
| Drift < **−300ms** (behind master) | Seek forward to correct position |
| Within tolerance | No action |

### Background Audio (Screen Lock)

On iOS and Android, browsers suspend the `AudioContext` when the screen locks. Cinewav prevents this with two mechanisms:

1. **Silent audio loop**: A near-silent `<audio>` element plays in a loop, keeping the browser's audio session active and preventing `AudioContext` suspension.
2. **Media Session API**: The app registers as a media player with the OS, appearing on the lock screen and preventing the browser from being killed.
3. **Visibility change handler**: When the screen is unlocked, the app immediately resumes the `AudioContext` and checks for drift.

---

## Project Structure

```
cinewav-web/
├── worker/                  # Cloudflare Worker + Durable Object
│   ├── src/
│   │   ├── index.ts         # Worker entry point, routing, CORS
│   │   └── showRoom.ts      # ShowRoom Durable Object (sync engine)
│   └── wrangler.toml        # Cloudflare deployment config
│
├── master/                  # Master Player web app
│   ├── src/
│   │   └── main.ts          # Master controller (audio + WebSocket)
│   └── index.html           # Master UI
│
├── audience/                # Audience PWA
│   ├── src/
│   │   ├── main.ts          # App orchestrator
│   │   ├── syncEngine.ts    # NTP clock sync + drift correction
│   │   └── audioStorage.ts  # IndexedDB audio file persistence
│   ├── public/
│   │   └── silent.mp3       # Silent loop for background audio
│   └── index.html           # Audience UI (mobile-first)
│
├── deploy.sh                # One-command deployment script
└── README.md                # This file
```

---

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) v8+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v3+
- A [Cloudflare account](https://dash.cloudflare.com/) (free tier works for development)

---

## Local Development

### 1. Install dependencies

```bash
cd cinewav-web/worker && pnpm install
cd ../master && pnpm install
cd ../audience && pnpm install
```

### 2. Start the sync worker locally

```bash
cd worker
wrangler dev --port 8787
```

### 3. Start the Master app

```bash
cd master
pnpm dev   # Runs on http://localhost:5173
```

### 4. Start the Audience app

```bash
cd audience
pnpm dev   # Runs on http://localhost:5174
```

### 5. Open both apps

- **Master**: http://localhost:5173
  - Show ID: `demo`
  - Server URL: `http://localhost:8787`
- **Audience**: http://localhost:5174
  - Show ID: `demo`
  - Server URL: `http://localhost:8787`

---

## Production Deployment

### Option A: One-command deploy

```bash
# Log in to Cloudflare first
wrangler login

# Deploy everything
./deploy.sh
```

### Option B: Manual step-by-step

```bash
# 1. Deploy the Worker
cd worker
wrangler deploy

# 2. Deploy the Master app
cd ../master
pnpm build
wrangler pages deploy dist --project-name cinewav-master

# 3. Deploy the Audience PWA
cd ../audience
pnpm build
wrangler pages deploy dist --project-name cinewav-audience
```

### Post-deployment configuration

After deploying the Worker, update the `ALLOWED_ORIGINS` variable in `worker/wrangler.toml` with your actual Pages URLs:

```toml
[vars]
ALLOWED_ORIGINS = "https://cinewav-master.pages.dev,https://cinewav-audience.pages.dev"
```

Then redeploy the worker: `wrangler deploy`

---

## Audio File Hosting (R2)

For production, audio files should be stored in **Cloudflare R2** (zero egress cost):

```bash
# Create R2 bucket
wrangler r2 bucket create cinewav-audio

# Upload an audio file
wrangler r2 object put cinewav-audio/show-001/audio.mp3 --file ./audio.mp3
```

Add the R2 binding to `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "AUDIO_BUCKET"
bucket_name = "cinewav-audio"
```

The Worker's `/api/show/:id/audio` endpoint will then serve the file directly from R2.

---

## WebSocket Message Protocol

### Client → Server

| Message | Description |
|:---|:---|
| `{ type: "join", role: "master"\|"audience", clientId }` | Join a show room |
| `{ type: "ping", clientId, clientTs }` | NTP clock sync ping |
| `{ type: "command", action, position, masterTs, audioFile? }` | Master sends playback command |

### Server → Client

| Message | Description |
|:---|:---|
| `{ type: "welcome", ...showState }` | Sent on join with current show state |
| `{ type: "pong", clientTs, serverTs }` | NTP clock sync pong |
| `{ type: "sync", action, position, masterTs, serverTs, audioFile? }` | Playback command broadcast to audience |
| `{ type: "audience_count", count }` | Current listener count |

---

## Scaling

The system scales to tens of thousands of concurrent users without any configuration changes:

- Each **show** gets its own Durable Object instance
- Cloudflare automatically routes WebSocket connections to the nearest edge data centre
- The Durable Object uses **WebSocket Hibernation API** — connections are held open but the DO is not billed for idle time between messages
- Audio files served from **R2** have zero egress cost regardless of download volume

---

## Cost Estimate (Cloudflare Workers Paid Plan — $5/month base)

| Resource | Usage (10,000 audience, 4hr show) | Cost |
|:---|:---|:---|
| Worker requests | ~500,000 | $0.08 |
| Durable Object duration | ~4 hours active | $0.00 (free tier) |
| Durable Object WebSocket messages | ~50M messages | $0.50 |
| R2 storage (1 × 500MB audio file) | 0.5 GB | $0.01 |
| R2 egress (10,000 × 500MB downloads) | 0 GB (free egress) | $0.00 |
| **Total per event** | | **~$0.59** |
| **Total per month (4 events)** | | **~$7.36** |

Compare to a typical AWS setup (EC2 + ALB + ElastiCache): **$2,000–$3,000/month**.

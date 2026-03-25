/**
 * Cinewav Sync Worker — Entry Point
 *
 * Routes:
 *   GET  /api/show/:showId/ws          → WebSocket upgrade (audience + master)
 *   POST /api/show/:showId/ping        → NTP clock sync ping (HTTP fallback)
 *   GET  /api/show/:showId/state       → Current show state (REST)
 *   POST /api/show/:showId/command     → Master sends play/pause/seek (REST)
 *   PUT  /api/show/:showId/audio       → Master uploads audio file to R2
 *   GET  /api/show/:showId/audio       → Audience downloads audio file from R2
 *   GET  /api/health                   → Health check
 */

import { ShowRoom } from './showRoom';
export { ShowRoom };

export interface Env {
  SHOW_ROOM: DurableObjectNamespace;
  AUDIO_BUCKET: R2Bucket;
  ALLOWED_ORIGINS: string;
}

function corsHeaders(origin: string, allowedOrigins: string): HeadersInit {
  const allowed = allowedOrigins.split(',').map((o) => o.trim());
  const isAllowed = allowed.some((pattern) => {
    if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(origin);
    }
    return pattern === origin;
  });
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Audio-Filename, X-Audio-Hash',
    'Access-Control-Expose-Headers': 'X-Audio-Filename, X-Audio-Hash, Content-Length',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS || '*');

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // Health check
    if (url.pathname === '/api/health') {
      return new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    // Route /api/show/:showId/* to the appropriate Durable Object or R2
    const showMatch = url.pathname.match(/^\/api\/show\/([^/]+)(\/.*)?$/);
    if (showMatch) {
      const showId = showMatch[1];
      const subPath = showMatch[2] || '/';

      // ── Audio Upload (PUT) — master uploads audio file to R2 ──────────────
      if (subPath === '/audio' && request.method === 'PUT') {
        const filename = request.headers.get('X-Audio-Filename') || `${showId}.mp3`;
        const hash = request.headers.get('X-Audio-Hash') || '';
        const contentType = request.headers.get('Content-Type') || 'audio/mpeg';
        const r2Key = `shows/${showId}/audio`;

        // Stream directly into R2 — no memory buffering needed
        await env.AUDIO_BUCKET.put(r2Key, request.body, {
          httpMetadata: {
            contentType,
            cacheControl: 'public, max-age=86400',
          },
          customMetadata: {
            filename,
            hash,
            showId,
            uploadedAt: new Date().toISOString(),
          },
        });

        // Notify the Durable Object that audio is now available
        const doId = env.SHOW_ROOM.idFromName(showId);
        const stub = env.SHOW_ROOM.get(doId);
        await stub.fetch(new Request(`${url.origin}/api/show/${showId}/audio-ready`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename, hash }),
        }));

        return new Response(JSON.stringify({ ok: true, filename, hash }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...cors },
        });
      }

      // ── Audio Download (GET) — audience downloads audio file from R2 ──────
      if (subPath === '/audio' && request.method === 'GET') {
        const r2Key = `shows/${showId}/audio`;
        const object = await env.AUDIO_BUCKET.get(r2Key);

        if (!object) {
          return new Response(JSON.stringify({ error: 'Audio not found for this show' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        }

        const filename = object.customMetadata?.filename || `${showId}.mp3`;
        const hash = object.customMetadata?.hash || '';

        return new Response(object.body, {
          status: 200,
          headers: {
            'Content-Type': object.httpMetadata?.contentType || 'audio/mpeg',
            'Content-Length': String(object.size),
            'Cache-Control': 'public, max-age=86400',
            'X-Audio-Filename': filename,
            'X-Audio-Hash': hash,
            ...cors,
          },
        });
      }

      // ── All other /api/show/:id/* routes → Durable Object ─────────────────
      const doId = env.SHOW_ROOM.idFromName(showId);
      const stub = env.SHOW_ROOM.get(doId);

      const doRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
      });

      const response = await stub.fetch(doRequest);

      // For WebSocket upgrades (101), return the response as-is
      if (response.status === 101) {
        return response;
      }

      // Attach CORS headers to all other responses
      const newHeaders = new Headers(response.headers);
      for (const [k, v] of Object.entries(cors)) {
        newHeaders.set(k, v);
      }
      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    }

    return new Response('Not Found', { status: 404, headers: cors });
  },
};

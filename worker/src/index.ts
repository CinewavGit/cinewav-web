/**
 * Cinewav Sync Worker — Entry Point
 *
 * Routes:
 *   GET  /api/show/:showId/ws          → WebSocket upgrade (audience + master)
 *   POST /api/show/:showId/ping        → NTP clock sync ping (HTTP fallback)
 *   GET  /api/show/:showId/state       → Current show state (REST)
 *   POST /api/show/:showId/command     → Master sends play/pause/seek (REST)
 *   GET  /api/health                   → Health check
 */

import { ShowRoom } from './showRoom';

export { ShowRoom };

export interface Env {
  SHOW_ROOM: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
}

function corsHeaders(origin: string, allowedOrigins: string): HeadersInit {
  const allowed = allowedOrigins.split(',').map((o) => o.trim());
  const isAllowed = allowed.includes(origin) || allowed.includes('*');
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

    // Route /api/show/:showId/* to the appropriate Durable Object
    const showMatch = url.pathname.match(/^\/api\/show\/([^/]+)(\/.*)?$/);
    if (showMatch) {
      const showId = showMatch[1];
      // Each show gets its own Durable Object instance, named by showId
      const id = env.SHOW_ROOM.idFromName(showId);
      const stub = env.SHOW_ROOM.get(id);
      // Forward the request to the Durable Object, preserving headers
      // For WebSocket upgrades, must pass the original request directly
      const doRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
      });
      const response = await stub.fetch(doRequest);
      // For WebSocket upgrades (101), return the response as-is
      // Modifying headers on a 101 response breaks the upgrade
      if (response.status === 101) {
        return response;
      }
      // Attach CORS headers to non-WebSocket responses
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

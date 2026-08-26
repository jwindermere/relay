import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Pool } from 'pg';

import type { RelayAuth } from './auth.js';
import { subscribeToAccessRevocations } from './authentication/access-revocation.js';
import { authorizeWorkspaceRequest } from './authentication/authorization.js';

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function rejectUpgrade(socket: Duplex): void {
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  socket.destroy();
}

export function attachAuthenticatedRealtime(
  server: HttpServer,
  pool: Pool,
  auth: RelayAuth
): WebSocketServer {
  const realtime = new WebSocketServer({ noServer: true });
  const socketsByUser = new Map<string, Set<WebSocket>>();
  const socketsBySession = new Map<string, Set<WebSocket>>();
  const unsubscribe = subscribeToAccessRevocations(pool, (revocation) => {
    const sockets = revocation.kind === 'session'
      ? socketsBySession.get(revocation.sessionId)
      : socketsByUser.get(revocation.userId);
    for (const websocket of sockets ?? []) {
      websocket.close(1008, 'Workspace access revoked');
    }
  });

  realtime.once('close', () => {
    void unsubscribe.then((stop) => stop());
  });

  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay.local');
    if (url.pathname !== '/realtime') {
      socket.destroy();
      return;
    }

    const headers = requestHeaders(request);
    try {
      await unsubscribe;
      const access = await authorizeWorkspaceRequest(pool, auth, headers);
      realtime.handleUpgrade(request, socket, head, (websocket) => {
        realtime.emit('connection', websocket, request);
        const userSockets = socketsByUser.get(access.identity.userId) ?? new Set<WebSocket>();
        const sessionSockets = socketsBySession.get(access.identity.sessionId) ?? new Set<WebSocket>();
        userSockets.add(websocket);
        sessionSockets.add(websocket);
        socketsByUser.set(access.identity.userId, userSockets);
        socketsBySession.set(access.identity.sessionId, sessionSockets);
        websocket.once('close', () => {
          userSockets.delete(websocket);
          sessionSockets.delete(websocket);
          if (userSockets.size === 0) socketsByUser.delete(access.identity.userId);
          if (sessionSockets.size === 0) socketsBySession.delete(access.identity.sessionId);
        });
        websocket.send(JSON.stringify({ type: 'ready', workspaceId: access.workspace.id }));

        websocket.on('message', async () => {
          try {
            await authorizeWorkspaceRequest(pool, auth, headers);
            websocket.send(JSON.stringify({ type: 'ack' }));
          } catch {
            websocket.close(1008, 'Workspace access revoked');
          }
        });
      });
    } catch {
      rejectUpgrade(socket);
    }
  });

  return realtime;
}

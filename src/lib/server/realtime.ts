import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Notification, Pool, PoolClient } from 'pg';

import type { RelayAuth } from './auth.js';
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
  let notificationClient: PoolClient | undefined;
  const onNotification = ({ channel, payload }: Notification) => {
    if (channel !== 'relay_access_revoked' || !payload) return;
    for (const websocket of socketsByUser.get(payload) ?? []) {
      websocket.close(1008, 'Workspace access revoked');
    }
  };
  const notificationsReady = pool.connect().then(async (client) => {
    notificationClient = client;
    client.on('notification', onNotification);
    await client.query('LISTEN relay_access_revoked');
  });

  realtime.once('close', () => {
    void notificationsReady.finally(async () => {
      if (!notificationClient) return;
      notificationClient.removeListener('notification', onNotification);
      await notificationClient.query('UNLISTEN relay_access_revoked');
      notificationClient.release();
      notificationClient = undefined;
    });
  });

  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay.local');
    if (url.pathname !== '/realtime') {
      socket.destroy();
      return;
    }

    const headers = requestHeaders(request);
    try {
      await notificationsReady;
      const access = await authorizeWorkspaceRequest(pool, auth, headers);
      realtime.handleUpgrade(request, socket, head, (websocket) => {
        realtime.emit('connection', websocket, request);
        const userSockets = socketsByUser.get(access.identity.userId) ?? new Set<WebSocket>();
        userSockets.add(websocket);
        socketsByUser.set(access.identity.userId, userSockets);
        websocket.once('close', () => {
          userSockets.delete(websocket);
          if (userSockets.size === 0) socketsByUser.delete(access.identity.userId);
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

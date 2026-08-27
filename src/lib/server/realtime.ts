import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Pool } from 'pg';

import type { RelayAuth } from './auth.js';
import { subscribeToAccessRevocations } from './authentication/access-revocation.js';
import { authorizeWorkspaceRequest } from './authentication/authorization.js';
import {
  subscribeToChannelWakeups,
  type ChannelWakeup
} from './collaboration/realtime-wakeup.js';
import { hasActivePilotChannelAccess } from './collaboration/channel-access.js';
import { verifyRealtimeTicket } from './realtime-ticket.js';

interface RealtimeClient {
  headers: Headers;
  memberId: string;
  memberName: string;
  subscriptions: Set<string>;
  websocket: WebSocket;
  workspaceId: string;
}

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

function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  const forwardedProtocol = request.headers['x-forwarded-proto'];
  const protocol = (Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol)
    ?.split(',', 1)[0]?.trim()
    ?? ((request.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  if (!origin || !host) return false;
  try {
    return new URL(origin).origin === `${protocol}://${host}`;
  } catch {
    return false;
  }
}

export function attachAuthenticatedRealtime(
  server: HttpServer,
  pool: Pool,
  auth: RelayAuth,
  ticketSecret: string,
  options: { ignoreUnknownUpgrades?: boolean } = {}
): WebSocketServer {
  const realtime = new WebSocketServer({ noServer: true });
  const clients = new Set<RealtimeClient>();
  const socketsByMembership = new Map<string, Set<WebSocket>>();
  const socketsBySession = new Map<string, Set<WebSocket>>();
  const subscriptionReady = subscribeToAccessRevocations(pool, (revocation) => {
    const sockets = revocation.kind === 'session'
      ? socketsBySession.get(revocation.sessionId)
      : socketsByMembership.get(revocation.membershipId);
    for (const websocket of sockets ?? []) {
      websocket.close(1008, 'Workspace access revoked');
    }
  });
  const wakeupsReady = subscribeToChannelWakeups(pool, async (wakeup: ChannelWakeup) => {
    for (const client of clients) {
      if (client.websocket.readyState !== WebSocket.OPEN
        || client.workspaceId !== wakeup.workspaceId
        || !client.subscriptions.has(wakeup.channelId)) continue;
      try {
        const access = await authorizeWorkspaceRequest(pool, auth, client.headers);
        if (!await hasActivePilotChannelAccess(
          pool,
          access,
          wakeup.channelId
        )) continue;
        client.websocket.send(JSON.stringify({ type: 'wake', channelId: wakeup.channelId }));
      } catch {
        client.websocket.close(1008, 'Workspace access revoked');
      }
    }
  });

  realtime.once('close', () => {
    void subscriptionReady.then((unsubscribe) => unsubscribe());
    void wakeupsReady.then((unsubscribe) => unsubscribe());
  });

  const broadcastTyping = (
    sender: RealtimeClient,
    channelId: string,
    active: boolean
  ) => {
    const payload = JSON.stringify({
      type: 'typing',
      channelId,
      memberId: sender.memberId,
      memberName: sender.memberName,
      active
    });
    for (const client of clients) {
      if (client.websocket.readyState !== WebSocket.OPEN
        || client.workspaceId !== sender.workspaceId
        || client.memberId === sender.memberId
        || !client.subscriptions.has(channelId)) continue;
      client.websocket.send(payload);
    }
  };

  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://relay.local');
    if (url.pathname !== '/realtime') {
      if (!options.ignoreUnknownUpgrades) socket.destroy();
      return;
    }
    if (!isSameOrigin(request)) {
      rejectUpgrade(socket);
      return;
    }

    const headers = requestHeaders(request);
    try {
      await Promise.all([subscriptionReady, wakeupsReady]);
      const access = await authorizeWorkspaceRequest(pool, auth, headers);
      if (!verifyRealtimeTicket(
        url.searchParams.get('ticket') ?? '',
        access.identity.sessionId,
        ticketSecret
      )) {
        rejectUpgrade(socket);
        return;
      }
      const identity = await pool.query<{ member_id: string; member_name: string }>(
        `SELECT member.id AS member_id, pilot_user.name AS member_name
         FROM public.workspace_member member
         JOIN public.workspace_membership membership
           ON membership.id = member.pilot_membership_id
         JOIN auth."user" pilot_user ON pilot_user.id = membership.user_id
         WHERE member.workspace_id = $1
           AND membership.id = $2
           AND membership.revoked_at IS NULL`,
        [access.workspace.id, access.membership.id]
      );
      const member = identity.rows[0];
      if (!member) {
        rejectUpgrade(socket);
        return;
      }
      realtime.handleUpgrade(request, socket, head, (websocket) => {
        realtime.emit('connection', websocket, request);
        const membershipKey = access.membership.id;
        const membershipSockets = socketsByMembership.get(membershipKey) ?? new Set<WebSocket>();
        const sessionSockets = socketsBySession.get(access.identity.sessionId) ?? new Set<WebSocket>();
        membershipSockets.add(websocket);
        sessionSockets.add(websocket);
        socketsByMembership.set(membershipKey, membershipSockets);
        socketsBySession.set(access.identity.sessionId, sessionSockets);
        const client: RealtimeClient = {
          headers,
          memberId: member.member_id,
          memberName: member.member_name,
          subscriptions: new Set(),
          websocket,
          workspaceId: access.workspace.id
        };
        clients.add(client);
        websocket.once('close', () => {
          for (const channelId of client.subscriptions) {
            broadcastTyping(client, channelId, false);
          }
          clients.delete(client);
          membershipSockets.delete(websocket);
          sessionSockets.delete(websocket);
          if (membershipSockets.size === 0) socketsByMembership.delete(membershipKey);
          if (sessionSockets.size === 0) socketsBySession.delete(access.identity.sessionId);
        });
        websocket.send(JSON.stringify({ type: 'ready', workspaceId: access.workspace.id }));

        websocket.on('message', async (data) => {
          try {
            const message = JSON.parse(data.toString()) as {
              type?: unknown;
              channelId?: unknown;
              active?: unknown;
            };
            if (typeof message.channelId !== 'string') {
              throw new Error('invalid realtime message');
            }
            const currentAccess = await authorizeWorkspaceRequest(pool, auth, headers);
            if (!await hasActivePilotChannelAccess(pool, currentAccess, message.channelId)) {
              throw new Error('Channel access is required');
            }
            if (message.type === 'subscribe') {
              client.subscriptions.add(message.channelId);
              websocket.send(JSON.stringify({
                type: 'subscribed',
                channelId: message.channelId
              }));
            } else if (
              message.type === 'typing'
              && typeof message.active === 'boolean'
              && client.subscriptions.has(message.channelId)
            ) {
              broadcastTyping(client, message.channelId, message.active);
            } else {
              throw new Error('invalid realtime message');
            }
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

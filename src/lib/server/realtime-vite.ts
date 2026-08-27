import type { Plugin, ViteDevServer } from 'vite';

export interface CloseableRealtimeServer {
  close(): void;
}

export function createRealtimeDevelopmentPlugin(
  attach: (server: NonNullable<ViteDevServer['httpServer']>) => CloseableRealtimeServer
): Plugin {
  let realtime: CloseableRealtimeServer | undefined;

  return {
    name: 'relay-realtime',
    apply: 'serve',
    configureServer(server) {
      if (!server.httpServer) {
        throw new Error('Relay realtime requires Vite to own an HTTP server');
      }
      realtime = attach(server.httpServer);
      server.httpServer.once('close', () => {
        realtime?.close();
        realtime = undefined;
      });
    }
  };
}

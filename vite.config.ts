import tailwindcss from '@tailwindcss/vite';
import type { Server } from 'node:http';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

import { getRelayAuth } from './src/lib/server/auth.js';
import { getDatabasePool } from './src/lib/server/database/pool.js';
import { attachAuthenticatedRealtime } from './src/lib/server/realtime.js';
import { requireRealtimeSecret } from './src/lib/server/realtime-ticket.js';
import { createRealtimeDevelopmentPlugin } from './src/lib/server/realtime-vite.js';

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit(),
    createRealtimeDevelopmentPlugin((server) => attachAuthenticatedRealtime(
      server as Server,
      getDatabasePool(),
      getRelayAuth(),
      requireRealtimeSecret(),
      { ignoreUnknownUpgrades: true }
    ))
  ]
});

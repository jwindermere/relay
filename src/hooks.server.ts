import { building } from '$app/environment';
import { svelteKitHandler } from 'better-auth/svelte-kit';

import { getRelayAuth } from '$lib/server/auth.js';

export async function handle({ event, resolve }) {
  if (building) return resolve(event);

  const auth = getRelayAuth();
  const authenticated = await auth.api.getSession({
    headers: event.request.headers,
    query: { disableCookieCache: true }
  });

  event.locals.authenticated = authenticated
    ? {
        sessionId: authenticated.session.id,
        userId: authenticated.user.id,
        email: authenticated.user.email,
        emailVerified: authenticated.user.emailVerified
      }
    : null;

  return svelteKitHandler({ auth, event, resolve, building });
}

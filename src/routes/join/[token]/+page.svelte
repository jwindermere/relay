<script lang="ts">
  import { page } from '$app/state';
  import BrandMark from '$lib/BrandMark.svelte';

  let name = $state('');
  let password = $state('');
  let busy = $state(false);
  let message = $state('');
  let registered = $state(false);

  async function register() {
    busy = true;
    message = '';
    try {
      const response = await fetch(`/api/workspace/invitations/${encodeURIComponent(page.params.token ?? '')}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, password })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Registration failed');
      registered = true;
      message = `Check ${result.account.email} for the verification link, then sign in and return to this invitation.`;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  async function accept() {
    busy = true;
    message = '';
    try {
      const response = await fetch(`/api/workspace/invitations/${encodeURIComponent(page.params.token ?? '')}/accept`, {
        method: 'POST'
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Invitation acceptance failed');
      window.location.assign('/');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>Join Relay</title>
  <meta name="description" content="Accept a Relay Workspace invitation" />
</svelte:head>

<main class="relay-shell flex min-h-screen items-center justify-center p-5">
  <section class="w-full max-w-md border border-white/12 bg-[#101113] p-7 sm:p-9">
    <BrandMark />
    <div class="eyebrow mt-10">Workspace invitation</div>
    <h1 class="font-display mt-2 text-3xl font-medium tracking-[-0.04em] text-white">Join the conversation</h1>
    <p class="mt-3 text-sm leading-6 text-base-content/50">Create your account, verify your email, then accept this invitation. Already registered and verified? Accept it now.</p>

    {#if !registered}
      <form class="mt-7 space-y-3" onsubmit={(event) => { event.preventDefault(); void register(); }}>
        <input class="input w-full" bind:value={name} autocomplete="name" placeholder="Your name" aria-label="Your name" required />
        <input class="input w-full" type="password" bind:value={password} autocomplete="new-password" minlength="8" maxlength="128" placeholder="Choose a password" aria-label="Choose a password" required />
        <button class="btn btn-primary w-full" type="submit" disabled={busy}>Create account</button>
      </form>
    {/if}

    <div class="mt-5 border-t border-white/10 pt-5">
      <button class="btn btn-outline w-full" type="button" disabled={busy} onclick={() => void accept()}>Accept with signed-in account</button>
      <a class="btn btn-ghost mt-2 w-full" href="/sign-in">Sign in</a>
    </div>
    {#if message}<p class="mt-5 text-sm leading-6 text-base-content/65" role="status">{message}</p>{/if}
  </section>
</main>

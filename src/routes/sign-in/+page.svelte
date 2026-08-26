<script lang="ts">
  let error = $state('');
  let submitting = $state(false);

  async function signIn(event: SubmitEvent) {
    submitting = true;
    error = '';
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const response = await fetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: form.get('email'),
        password: form.get('password')
      })
    });

    if (response.ok) {
      window.location.assign('/');
      return;
    }

    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    error = body?.message ?? 'Sign in failed';
    submitting = false;
  }
</script>

<svelte:head>
  <title>Sign in · Relay</title>
</svelte:head>

<main class="hero min-h-screen bg-base-200">
  <div class="hero-content w-full max-w-md">
    <form class="card w-full bg-base-100 shadow-xl" onsubmit={(event) => { event.preventDefault(); void signIn(event); }}>
      <div class="card-body gap-4">
        <h1 class="card-title text-3xl">Sign in to Relay</h1>
        <p class="text-sm text-base-content/70">Use the verified owner email bootstrapped locally.</p>
        <label class="form-control gap-2">
          <span class="label-text">Email</span>
          <input class="input input-bordered" name="email" type="email" autocomplete="email" required />
        </label>
        <label class="form-control gap-2">
          <span class="label-text">Password</span>
          <input class="input input-bordered" name="password" type="password" autocomplete="current-password" required />
        </label>
        {#if error}<p class="text-error" role="alert">{error}</p>{/if}
        <button class="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </div>
    </form>
  </div>
</main>

<script lang="ts">
  import BrandMark from '$lib/BrandMark.svelte';

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

<main class="relay-shell grid min-h-screen lg:grid-cols-[minmax(0,1fr)_27rem]">
  <section class="relative hidden border-r border-white/12 p-10 lg:flex lg:flex-col lg:justify-between xl:p-14">
    <div class="flex items-start justify-between">
      <BrandMark />
      <span class="index-label">01 — WORKSPACE</span>
    </div>
    <div class="max-w-3xl">
      <div class="auth-rule"></div>
      <h1 class="font-display mt-8 text-[clamp(3.4rem,6vw,6.8rem)] font-medium leading-[0.92] tracking-[-0.075em] text-[#f1efe8]">
        People.<br />Agents.<br /><span class="text-primary">One thread.</span>
      </h1>
    </div>
    <div class="flex items-end justify-between border-t border-white/12 pt-5">
      <p class="max-w-sm text-sm leading-6 text-base-content/44">A shared place to turn engineering conversations into reviewable work.</p>
      <span class="index-label">RELAY / 2026</span>
    </div>
  </section>

  <section class="flex min-h-screen items-center border-t-2 border-primary px-6 py-10 lg:border-t-0 lg:px-10">
    <div class="w-full">
      <div class="mb-20 flex items-center justify-between lg:hidden">
        <BrandMark />
        <span class="index-label">01 — SIGN IN</span>
      </div>
      <div class="eyebrow">Private access</div>
      <h2 class="font-display mt-4 text-3xl font-medium tracking-[-0.045em] text-[#f1efe8]">Enter Relay</h2>
      <p class="mt-2 text-sm leading-6 text-base-content/40">Continue to your shared workspace.</p>

      <form class="mt-12 border-t border-white/14 pt-7" onsubmit={(event) => { event.preventDefault(); void signIn(event); }}>
        <div class="space-y-6">
          <label class="form-control gap-2.5">
            <span class="eyebrow">Email</span>
            <input class="input h-12 w-full border-x-0 border-t-0 px-0 focus:outline-none" name="email" type="email" autocomplete="email" placeholder="you@company.com" required />
          </label>
          <label class="form-control gap-2.5">
            <span class="eyebrow">Password</span>
            <input class="input h-12 w-full border-x-0 border-t-0 px-0 focus:outline-none" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required />
          </label>
          {#if error}<p class="border-l-2 border-error pl-3 text-sm text-error" role="alert">{error}</p>{/if}
          <button class="btn btn-primary mt-4 h-12 w-full justify-between px-4" type="submit" disabled={submitting}>
            <span>{submitting ? 'Signing in…' : 'Continue'}</span><span aria-hidden="true">→</span>
          </button>
        </div>
        <div class="mt-6 flex items-center gap-2 text-[0.68rem] text-base-content/30">
          <span class="size-1.5 rounded-full bg-success"></span>
          Verified owner access only
        </div>
      </form>
    </div>
  </section>
</main>

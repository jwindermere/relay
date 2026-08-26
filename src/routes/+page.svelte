<script lang="ts">
  let { data } = $props();

  async function signOut() {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    window.location.assign('/sign-in');
  }
</script>

<svelte:head>
  <title>Relay</title>
  <meta name="description" content="Relay shared engineering agent workspace" />
</svelte:head>

<main class="hero min-h-screen bg-base-200">
  <div class="hero-content text-center">
    <div class="max-w-lg">
      <div class="badge badge-primary badge-outline mb-5">Authenticated workspace</div>
      <h1 class="text-5xl font-bold">Relay</h1>
      <p class="py-6 text-base-content/70">
        {data.email} is signed in as {data.role} of {data.workspaceName}.
      </p>
      <button class="btn btn-primary" type="button" onclick={() => void signOut()}>Sign out</button>
    </div>
  </div>
</main>

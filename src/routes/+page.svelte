<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';

  let { data, form } = $props();
  let replyToId = $state<string | null>(null);
  let composer = $state<HTMLTextAreaElement>();
  let providerBusy = $state(false);
  let providerMessage = $state('');
  let managedLogin = $state<{ verificationUrl: string; userCode: string } | null>(null);
  let roots = $derived(data.sharedChannel.messages.filter((message) => !message.parentMessageId));

  function repliesFor(rootId: string) {
    return data.sharedChannel.messages.filter((message) => message.parentMessageId === rootId);
  }

  function initials(name: string) {
    return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  }

  function beginReply(messageId: string) {
    replyToId = messageId;
    requestAnimationFrame(() => composer?.focus());
  }

  function formatTime(timestamp: string) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
      .format(new Date(timestamp));
  }

  async function signOut() {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    window.location.assign('/sign-in');
  }

  async function manageProvider(action: 'connect' | 'disable' | 'disconnect') {
    providerBusy = true;
    providerMessage = '';
    if (action !== 'connect') managedLogin = null;
    try {
      const response = await fetch('/api/workspace/provider', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Provider action failed');
      if (result.login) managedLogin = result.login;
      await invalidateAll();
    } catch (error) {
      providerMessage = error instanceof Error ? error.message : String(error);
    } finally {
      providerBusy = false;
    }
  }
</script>

<svelte:head>
  <title>#{data.sharedChannel.channel.name} · Relay</title>
  <meta name="description" content="Relay shared engineering agent workspace" />
</svelte:head>

<main class="mx-auto grid min-h-screen max-w-7xl md:grid-cols-[17rem_minmax(0,1fr)]">
  <aside class="border-base-300 bg-base-200/70 border-b p-4 md:border-r md:border-b-0">
    <div class="flex items-center justify-between gap-3">
      <span class="text-lg font-black">Relay</span>
      <button class="btn btn-ghost btn-xs" type="button" onclick={() => void signOut()}>Sign out</button>
    </div>

    <div class="mt-5 text-xs font-bold uppercase tracking-wider text-base-content/45">Project</div>
    <div class="mt-2 rounded-box bg-primary/10 p-3 text-sm font-semibold text-primary">{data.sharedChannel.project.name}</div>
    <div class="mt-5 text-xs font-bold uppercase tracking-wider text-base-content/45">Channels</div>
    <nav aria-label="Project channels" class="mt-2">
      <a class="flex rounded-lg bg-base-300/70 px-3 py-2 text-sm font-semibold" href="/"># {data.sharedChannel.channel.name}</a>
    </nav>

    <div class="mt-6 text-xs font-bold uppercase tracking-wider text-base-content/45">Provider connection</div>
    <section class="mt-2 rounded-box border-base-300 border bg-base-100 p-3" aria-label="Codex Provider connection">
      <div class="flex items-center justify-between gap-2">
        <strong class="text-sm">Codex</strong>
        <span class:badge-success={data.providerConnection.readyForExecution} class="badge badge-sm">
          {data.providerConnection.state.replace('_', ' ')}
        </span>
      </div>
      <p class="mt-2 text-xs leading-5 text-base-content/60">
        {data.providerConnection.readyForExecution
          ? 'Managed ChatGPT login is ready for shared Agent work.'
          : 'New Agent execution is unavailable.'}
      </p>
      {#if data.providerConnection.canManage}
        <div class="mt-3 flex flex-wrap gap-2">
          {#if data.providerConnection.state !== 'disconnecting'}
            <button class="btn btn-primary btn-xs" type="button" disabled={providerBusy} onclick={() => void manageProvider('connect')}>
              {data.providerConnection.state === 'not_connected' ? 'Connect' : 'Replace'}
            </button>
          {/if}
          {#if data.providerConnection.state === 'ready' || data.providerConnection.state === 'connecting'}
            <button class="btn btn-ghost btn-xs" type="button" disabled={providerBusy} onclick={() => void manageProvider('disable')}>Disable</button>
          {/if}
          {#if data.providerConnection.state !== 'not_connected'}
            <button class="btn btn-ghost btn-xs text-error" type="button" disabled={providerBusy} onclick={() => void manageProvider('disconnect')}>
              {data.providerConnection.state === 'disconnecting' ? 'Retry disconnect' : 'Disconnect'}
            </button>
          {/if}
        </div>
        {#if managedLogin}
          <div class="mt-3 rounded-lg bg-base-200 p-2 text-xs">
            <p>Open the managed Codex sign-in page and enter:</p>
            <code class="mt-1 block font-bold tracking-wider">{managedLogin.userCode}</code>
            <a class="link link-primary mt-1 inline-block" href={managedLogin.verificationUrl} target="_blank" rel="noreferrer">Continue with ChatGPT</a>
          </div>
        {/if}
        {#if providerMessage}<p class="mt-2 text-xs text-error" role="alert">{providerMessage}</p>{/if}
      {/if}
    </section>

    <div class="mt-6 text-xs font-bold uppercase tracking-wider text-base-content/45">Members</div>
    <ul class="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-3 md:grid-cols-1">
      {#each data.sharedChannel.members as member}
        <li class="agent-status group relative">
          <button
            class="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm outline-none hover:bg-base-300/60 focus-visible:ring-2 focus-visible:ring-primary"
            type="button"
            aria-describedby={member.kind === 'agent' ? `status-${member.id}` : undefined}
          >
            <span class:agent-avatar={member.kind === 'agent'} class="member-avatar">
              {initials(member.name)}
              <span class:status-working={member.status === 'working'} class:status-waiting={member.status === 'waiting'} class:status-disabled={member.status === 'disabled'} class="member-status"></span>
            </span>
            <span class="min-w-0">
              <strong class="block truncate">{member.name}</strong>
              <span class="block truncate text-xs text-base-content/50">
                {member.kind === 'agent' ? `${member.roleLabel} · ${member.status}` : member.roleLabel}
              </span>
            </span>
          </button>
          {#if member.kind === 'agent'}
            <div id={`status-${member.id}`} role="tooltip" class="agent-tooltip">
              <strong>{member.name} · {member.status}</strong>
              <span class="mt-1 block text-xs text-base-content/65">
                {member.status === 'idle'
                  ? (data.providerConnection.readyForExecution
                    ? 'Ready for an engineering request in this Project.'
                    : 'A ready Codex Provider connection is required before new work.')
                  : `${member.roleLabel} is ${member.status}.`}
              </span>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </aside>

  <section class="flex min-w-0 flex-col bg-base-100">
    <header class="border-base-300 border-b px-5 py-4">
      <h1 class="font-bold"># {data.sharedChannel.channel.name}</h1>
      <p class="text-xs text-base-content/55">Shared Channel · {data.sharedChannel.project.name} · {data.sharedChannel.members.length} members</p>
    </header>

    <div class="flex-1 p-4 sm:p-6">
      {#if roots.length === 0}
        <div class="mx-auto max-w-xl py-14 text-center">
          <div class="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-xl font-black text-primary">#</div>
          <h2 class="mt-4 text-xl font-bold">Start the shared conversation</h2>
          <p class="mt-2 text-sm leading-6 text-base-content/60">Both Pilot members and Alex are here. Messages remain in this Project after reload.</p>
        </div>
      {:else}
        <div class="mx-auto max-w-3xl space-y-4" aria-live="polite">
          {#each roots as message}
            <article class="rounded-box border-base-300 border bg-base-100 p-4 shadow-sm">
              <div class="flex gap-3">
                <div class:agent-avatar={message.author.kind === 'agent'} class="member-avatar shrink-0">{initials(message.author.name)}</div>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-baseline gap-2">
                    <strong>{message.author.name}</strong>
                    <span class="text-xs text-base-content/45">{message.author.roleLabel} · {formatTime(message.createdAt)}</span>
                  </div>
                  <p class="mt-1 whitespace-pre-wrap text-sm leading-6">{message.body}</p>
                  <button class="btn btn-ghost btn-xs mt-2" type="button" onclick={() => beginReply(message.id)}>Reply</button>
                </div>
              </div>

              {#if repliesFor(message.id).length > 0}
                <div class="border-base-300 ml-5 mt-3 space-y-3 border-l pl-5 sm:ml-12">
                  {#each repliesFor(message.id) as reply}
                    <div class="flex gap-3">
                      <div class:agent-avatar={reply.author.kind === 'agent'} class="member-avatar member-avatar-small shrink-0">{initials(reply.author.name)}</div>
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-baseline gap-2">
                          <strong class="text-sm">{reply.author.name}</strong>
                          <span class="text-xs text-base-content/45">{formatTime(reply.createdAt)}</span>
                        </div>
                        <p class="mt-1 whitespace-pre-wrap text-sm leading-6">{reply.body}</p>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </div>

    <div class="sticky bottom-0 border-base-300 border-t bg-base-100/95 p-4 backdrop-blur sm:px-6">
      <form
        method="POST"
        action="?/send"
        class="mx-auto max-w-3xl"
        use:enhance={() => async ({ update }) => {
          await update({ reset: true });
          replyToId = null;
          await invalidateAll();
        }}
      >
        <input type="hidden" name="channelId" value={data.sharedChannel.channel.id} />
        <input type="hidden" name="parentMessageId" value={replyToId ?? ''} />
        {#if replyToId}
          <div class="mb-2 flex items-center justify-between rounded-lg bg-base-200 px-3 py-2 text-xs">
            <span>Replying to a channel Message</span>
            <button class="btn btn-ghost btn-xs" type="button" onclick={() => (replyToId = null)}>Cancel</button>
          </div>
        {/if}
        <div class="rounded-box border-base-300 flex items-end gap-2 border p-2 shadow-sm focus-within:border-primary">
          <textarea
            bind:this={composer}
            class="textarea textarea-ghost min-h-12 flex-1 resize-none focus:outline-none"
            name="body"
            maxlength="4000"
            required
            aria-label={`Message #${data.sharedChannel.channel.name}`}
            placeholder={replyToId ? 'Write a direct reply' : `Message #${data.sharedChannel.channel.name}`}
          ></textarea>
          <button class="btn btn-primary btn-sm" type="submit">Send</button>
        </div>
        {#if form?.message}<p class="mt-2 text-sm text-error" role="alert">{form.message}</p>{/if}
      </form>
    </div>
  </section>
</main>

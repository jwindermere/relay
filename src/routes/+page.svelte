<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { onMount } from 'svelte';
  import {
    applyChannelReconciliation,
    encodeAgentRunCursors,
    mergeChannelMessages,
    latestVisibleAgentRunForSource,
    type ChannelReconciliationUpdate,
    type VisibleAgentRuns,
    type VisibleAgentRunStatus
  } from '$lib/reconciliation.js';

  let { data, form } = $props();
  let replyToId = $state<string | null>(null);
  let composer = $state<HTMLTextAreaElement>();
  let providerBusy = $state(false);
  let providerMessage = $state('');
  let managedLogin = $state<{ verificationUrl: string; userCode: string } | null>(null);
  let githubBusy = $state(false);
  let githubMessage = $state('');
  let githubInstallationId = $state('');
  let githubReleaseBranches = $state('');
  let realtimeRuns = $state<VisibleAgentRuns>({});
  let realtimeMessages = $state<typeof data.sharedChannel.messages>([]);
  let reconciliationActive: Promise<void> | null = null;
  let reconciliationRequested = false;
  let githubConfiguration = $derived(data.linkedRepository.configuration);
  let agentRuns = $derived(applyChannelReconciliation(realtimeRuns, data.reconciliation));
  let channelMessages = $derived(mergeChannelMessages(
    data.sharedChannel.messages,
    realtimeMessages
  ));
  let roots = $derived(channelMessages.filter((message) => !message.parentMessageId));

  function repliesFor(rootId: string) {
    return channelMessages.filter((message) => message.parentMessageId === rootId);
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

  function statusLabel(status: VisibleAgentRunStatus) {
    return status.replaceAll('_', ' ');
  }

  function requestReconciliation(): Promise<void> {
    reconciliationRequested = true;
    if (reconciliationActive) return reconciliationActive;
    reconciliationActive = (async () => {
      while (reconciliationRequested) {
        reconciliationRequested = false;
        const cursors = Object.fromEntries(
          Object.values(agentRuns).map((run) => [run.id, run.sequence])
        );
        const query = new URLSearchParams({ after: encodeAgentRunCursors(cursors) });
        const response = await fetch(
          `/api/workspace/channel/${encodeURIComponent(data.sharedChannel.channel.id)}/reconciliation?${query}`
        );
        if (response.status === 401) {
          window.location.assign('/sign-in');
          return;
        }
        if (!response.ok) throw new Error('Channel status could not be refreshed');
        const update = await response.json() as ChannelReconciliationUpdate & {
          messages: typeof data.sharedChannel.messages;
        };
        realtimeMessages = mergeChannelMessages(realtimeMessages, update.messages);
        realtimeRuns = applyChannelReconciliation(agentRuns, update);
      }
    })().catch(() => {
      // A later wake, focus, or reconnect retries from the last durable cursor.
    }).finally(() => {
      reconciliationActive = null;
      if (reconciliationRequested) void requestReconciliation();
    });
    return reconciliationActive;
  }

  onMount(() => {
    let stopped = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let websocket: WebSocket | undefined;
    const connect = () => {
      if (stopped) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      websocket = new WebSocket(`${protocol}//${window.location.host}/realtime`);
      websocket.addEventListener('message', async ({ data: payload }) => {
        let message: { type?: string; channelId?: string };
        try {
          message = JSON.parse(String(payload));
        } catch {
          return;
        }
        if (message.type === 'ready') {
          await requestReconciliation();
          if (websocket?.readyState === WebSocket.OPEN) {
            websocket.send(JSON.stringify({
              type: 'subscribe',
              channelId: data.sharedChannel.channel.id
            }));
          }
        } else if (
          message.type === 'wake'
          && message.channelId === data.sharedChannel.channel.id
        ) {
          void requestReconciliation();
        } else if (
          message.type === 'subscribed'
          && message.channelId === data.sharedChannel.channel.id
        ) {
          // Close the fetch-to-subscribe race with one final durable read.
          void requestReconciliation();
        }
      });
      websocket.addEventListener('close', () => {
        if (!stopped) reconnectTimer = setTimeout(connect, 1_000);
      });
    };
    const wake = () => void requestReconciliation();
    const visibilityWake = () => {
      if (document.visibilityState === 'visible') wake();
    };
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', visibilityWake);
    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      websocket?.close();
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
      document.removeEventListener('visibilitychange', visibilityWake);
    };
  });

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

  async function manageGitHub(action: 'link' | 'verify' | 'disable') {
    githubBusy = true;
    githubMessage = '';
    try {
      const response = await fetch('/api/workspace/github', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'link' ? {
          action,
          installationId: githubInstallationId.trim(),
          releaseBranches: githubReleaseBranches
            .split(',')
            .map((branch) => branch.trim())
            .filter(Boolean)
        } : { action })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'GitHub repository action failed');
      await invalidateAll();
    } catch (error) {
      githubMessage = error instanceof Error ? error.message : String(error);
    } finally {
      githubBusy = false;
    }
  }
</script>

{#snippet agentMentionStatus(message: (typeof data.sharedChannel.messages)[number])}
  {#if message.agentMention?.status === 'accepted'}
    {@const run = latestVisibleAgentRunForSource(agentRuns, message.id)}
    <p class="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-success" role="status">
      {#if run}
        <span class="badge badge-sm badge-success">{statusLabel(run.status)}</span>
        {#if run.attemptNumber > 1}<span>Attempt {run.attemptNumber}</span>{/if}
        <span>{run.summary}</span>
      {:else}
        <span>Engineering request queued</span>
      {/if}
    </p>
    {#if run?.artifact}
      <a
        class="btn btn-outline btn-primary btn-xs mt-2"
        href={run.artifact.url}
        target="_blank"
        rel="noopener noreferrer"
      >Review pull request #{run.artifact.pullRequestNumber} in GitHub</a>
    {/if}
    {#if run && run.milestones.length > 1}
      <ul class="mt-1 space-y-1 text-xs text-base-content/55" aria-label="Engineering request milestones">
        {#each run.milestones.slice(0, -1) as entry (`${run.id}:${entry.sequence}`)}
          <li>{entry.summary}</li>
        {/each}
      </ul>
    {/if}
  {:else if message.agentMention?.status === 'rejected'}
    <p class="mt-2 text-xs text-warning" role="status">{message.agentMention.reason}</p>
  {/if}
{/snippet}

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

    <div class="mt-6 text-xs font-bold uppercase tracking-wider text-base-content/45">Linked repository</div>
    <section class="mt-2 rounded-box border-base-300 border bg-base-100 p-3" aria-label="Linked pilot repository">
      <div class="flex items-center justify-between gap-2">
        <strong class="text-sm">GitHub</strong>
        <span class:badge-success={data.linkedRepository.readyForAutonomousWork} class="badge badge-sm">
          {data.linkedRepository.githubConnectionState.replace('_', ' ')}
        </span>
      </div>
      <p class="mt-2 text-xs leading-5 text-base-content/60">
        {data.linkedRepository.readyForAutonomousWork
          ? 'Human-reviewed branch controls are verified.'
          : 'Autonomous repository work is unavailable.'}
      </p>
      {#if githubConfiguration}
        <p class="mt-2 break-all text-xs font-semibold">
          {githubConfiguration.repository.owner}/{githubConfiguration.repository.name}
        </p>
        {#if githubConfiguration.protection.failures.length > 0}
          <ul class="mt-2 list-disc pl-4 text-xs text-error">
            {#each githubConfiguration.protection.failures as failure}
              <li>{failure}</li>
            {/each}
          </ul>
        {/if}
        {#each githubConfiguration.protection.branches.filter((branch) => !branch.protected) as branch}
          <div class="mt-2 text-xs text-error">
            <strong>{branch.name}</strong>: {branch.failures.join('; ')}
          </div>
        {/each}
      {/if}
      {#if data.linkedRepository.canManage}
        <div class="mt-3 space-y-2">
          <input class="input input-sm w-full" bind:value={githubInstallationId} inputmode="numeric" placeholder="Installation ID" aria-label="GitHub App installation ID" />
          <input class="input input-sm w-full" bind:value={githubReleaseBranches} placeholder="Release branches, comma separated" aria-label="Release branches" />
          <div class="flex flex-wrap gap-2">
            <button class="btn btn-primary btn-xs" type="button" disabled={githubBusy || !githubInstallationId.trim()} onclick={() => void manageGitHub('link')}>
              {data.linkedRepository.linkState === 'not_linked' ? 'Link selected repository' : 'Replace repository'}
            </button>
            {#if data.linkedRepository.linkState === 'linked'}
              <button class="btn btn-ghost btn-xs" type="button" disabled={githubBusy} onclick={() => void manageGitHub('verify')}>Verify controls</button>
            {/if}
            {#if data.linkedRepository.githubConnectionState === 'active'}
              <button class="btn btn-ghost btn-xs" type="button" disabled={githubBusy} onclick={() => void manageGitHub('disable')}>Disable</button>
            {/if}
          </div>
        </div>
        {#if githubMessage}<p class="mt-2 text-xs text-error" role="alert">{githubMessage}</p>{/if}
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
                  ? (data.readyForAgentExecution
                    ? 'Ready for an engineering request in this Project.'
                    : 'A ready Codex connection and verified Linked pilot repository are required before new work.')
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
                  {@render agentMentionStatus(message)}
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
                        {@render agentMentionStatus(reply)}
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
        use:enhance={() => async ({ result, update }) => {
          await update({ reset: true });
          if (result.type === 'success') {
            replyToId = null;
          }
          await invalidateAll();
        }}
      >
        <input type="hidden" name="channelId" value={data.sharedChannel.channel.id} />
        <input type="hidden" name="parentMessageId" value={replyToId ?? ''} />
        <input type="hidden" name="submissionId" value={data.messageSubmissionId} />
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

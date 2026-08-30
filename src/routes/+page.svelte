<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { onMount } from 'svelte';
  import BrandMark from '$lib/BrandMark.svelte';
  import JitsiCall from '$lib/JitsiCall.svelte';
  import MarkdownMessage from '$lib/MarkdownMessage.svelte';
  import { highlightMarkdownInput } from '$lib/markdown.js';
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
  let openThreadIds = $state<string[]>([]);
  let composer = $state<HTMLElement>();
  let messageBody = $state('');
  let showMarkdownMarkers = $state(false);
  let mentionStart = $state(-1);
  let mentionQuery = $state('');
  let activeMentionIndex = $state(0);
  let settingsDialog = $state<HTMLDialogElement>();
  let providerBusy = $state(false);
  let providerMessage = $state('');
  let managedLogin = $state<{ verificationUrl: string; userCode: string } | null>(null);
  let githubBusy = $state(false);
  let githubMessage = $state('');
  let githubInstallationId = $state('');
  let githubReleaseBranches = $state('');
  let githubNoBypassConfirmed = $state(false);
  let invitationEmail = $state('');
  let invitationBusy = $state(false);
  let invitationMessage = $state('');
  let invitationPath = $state('');
  let agentBusy = $state(false);
  let agentMessage = $state('');
  let editingAgentId = $state<string | null>(null);
  let agentName = $state('');
  let agentType = $state<'engineering' | 'research' | 'product' | 'support' | 'general'>('general');
  let agentRole = $state('');
  let agentInstructions = $state('');
  let agentParticipation = $state<'reactive' | 'ambient'>('ambient');
  let agentTopics = $state('');
  let agentReplyMode = $state<'adaptive' | 'channel' | 'thread'>('adaptive');
  let agentEnabled = $state(true);
  let agentTemplateKey = $state('');
  let inboxAgentFilter = $state('all');
  let inboxStateFilter = $state('all');
  let inboxUrgencyFilter = $state('all');
  let inboxHumanOnly = $state(false);
  let newWorkspaceName = $state('');
  let workspaceBusy = $state(false);
  let workspaceMessage = $state('');
  let workspaceNotice = $state('');
  let editingWorkspaceId = $state<string | null>(null);
  let editingWorkspaceName = $state('');
  let realtimeRuns = $state<VisibleAgentRuns>({});
  let realtimeMessages = $state<typeof data.sharedChannel.messages>([]);
  let realtimeHandoffs = $state<typeof data.reconciliation.handoffs>([]);
  let realtimeAccountability = $state<typeof data.accountability | null>(null);
  let activeCall = $state<typeof data.activeCall>(null);
  let callBusy = $state(false);
  let callMessage = $state('');
  let callView = $state<'closed' | 'inline' | 'floating'>('closed');
  let reconciliationActive: Promise<void> | null = null;
  let reconciliationRequested = false;
  let realtimeSocket: WebSocket | undefined;
  let realtimeSubscribed = false;
  let typingStopTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTypingSignalAt = 0;
  let humanTypers = $state<Record<string, { name: string; expiresAt: number }>>({});
  let githubConfiguration = $derived(data.linkedRepository.configuration);
  let agentRuns = $derived(applyChannelReconciliation(realtimeRuns, data.reconciliation));
  let accountability = $derived(realtimeAccountability ?? data.accountability);
  let filteredInbox = $derived(accountability.inbox.filter((item) =>
    (inboxAgentFilter === 'all' || item.agentId === inboxAgentFilter)
    && (inboxStateFilter === 'all' || item.state === inboxStateFilter)
    && (inboxUrgencyFilter === 'all' || item.urgency === inboxUrgencyFilter)
    && (!inboxHumanOnly || item.requiresHumanAction)
  ));
  let selectedAgentTemplate = $derived(
    data.agentTemplates.find((template) => template.key === agentTemplateKey)
  );
  let selectedTemplateOverlap = $derived(selectedAgentTemplate?.ambientTriggers.find((topic) =>
    data.agentConfiguration.agents.some((agent) => agent.ambientTriggers.includes(topic))
  ));
  let agentHandoffs = $derived(
    realtimeHandoffs.length > 0 ? realtimeHandoffs : data.reconciliation.handoffs
  );
  let channelMessages = $derived(mergeChannelMessages(
    data.sharedChannel.messages,
    realtimeMessages
  ));
  let roots = $derived(channelMessages.filter((message) => !message.parentMessageId));
  let sidebarMembers = $derived(data.sharedChannel.members.filter(
    (member) => member.id !== data.sharedChannel.viewerWorkspaceMemberId
  ));
  let mentionMatches = $derived(sidebarMembers.filter((member) =>
    member.name.toLocaleLowerCase().startsWith(mentionQuery.toLocaleLowerCase())
  ));
  let mentionMenuOpen = $derived(mentionStart >= 0 && mentionMatches.length > 0);
  let agentTypingNames = $derived.by(() => {
    const names = new Set<string>();
    for (const message of channelMessages) {
      if (message.agentMention?.status === 'conversation'
        && message.agentMention.turnStatus === 'working') {
        names.add(mentionedAgentName(message.agentMention.agentId));
      }
    }
    return [...names];
  });
  let typingNames = $derived([...new Set([
    ...agentTypingNames,
    ...Object.values(humanTypers).map(({ name }) => name)
  ])]);

  $effect(() => {
    activeCall = data.activeCall;
    realtimeAccountability = data.accountability;
  });

  function repliesFor(rootId: string) {
    return channelMessages.filter((message) => message.parentMessageId === rootId);
  }

  function handoffForSource(sourceMessageId: string) {
    return agentHandoffs.find((handoff) => handoff.sourceMessageId === sourceMessageId);
  }

  function planForSource(sourceMessageId: string) {
    return accountability.plans.find((plan) => plan.sourceMessageId === sourceMessageId);
  }

  function steeringForSource(sourceMessageId: string) {
    return accountability.steering.find((steering) => steering.sourceMessageId === sourceMessageId);
  }

  function initials(name: string) {
    return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  }

  function beginReply(messageId: string) {
    replyToId = messageId;
    if (!openThreadIds.includes(messageId)) openThreadIds = [...openThreadIds, messageId];
    requestAnimationFrame(() => composer?.focus());
  }

  function toggleThread(messageId: string) {
    openThreadIds = openThreadIds.includes(messageId)
      ? openThreadIds.filter((id) => id !== messageId)
      : [...openThreadIds, messageId];
  }

  function formatTime(timestamp: string) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
      .format(new Date(timestamp));
  }

  function calendarDateKey(timestamp: string) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function formatDateDivider(timestamp: string) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (calendarDateKey(timestamp) === calendarDateKey(today.toISOString())) return 'Today';
    if (calendarDateKey(timestamp) === calendarDateKey(yesterday.toISOString())) return 'Yesterday';
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
    }).format(date);
  }

  function statusLabel(status: VisibleAgentRunStatus) {
    return status.replaceAll('_', ' ');
  }

  function mentionedAgentName(agentId: string) {
    return data.agentConfiguration.agents.find((agent) => agent.id === agentId)?.name ?? 'Agent';
  }

  function canDeleteMessage(message: (typeof data.sharedChannel.messages)[number]) {
    return !message.deletedAt && (
      data.role === 'owner'
      || message.author.workspaceMemberId === data.sharedChannel.viewerWorkspaceMemberId
    );
  }

  function composerSelection(): { start: number; end: number } {
    if (!composer) return { start: messageBody.length, end: messageBody.length };
    const selection = window.getSelection();
    if (!selection?.rangeCount || !composer.contains(selection.anchorNode)) {
      return { start: messageBody.length, end: messageBody.length };
    }
    const offsetFor = (node: Node | null, offset: number) => {
      if (!node) return messageBody.length;
      const range = document.createRange();
      range.selectNodeContents(composer!);
      range.setEnd(node, offset);
      return range.toString().length;
    };
    const anchor = offsetFor(selection.anchorNode, selection.anchorOffset);
    const focus = offsetFor(selection.focusNode, selection.focusOffset);
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  }

  function restoreComposerSelection(start: number, end: number) {
    if (!composer) return;
    const range = document.createRange();
    const selection = window.getSelection();
    const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let startSet = false;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const nextOffset = offset + (node.textContent?.length ?? 0);
      if (!startSet && start <= nextOffset) {
        range.setStart(node, Math.max(0, start - offset));
        startSet = true;
      }
      if (end <= nextOffset) {
        if (!startSet) range.setStart(node, 0);
        range.setEnd(node, Math.max(0, end - offset));
        selection?.removeAllRanges();
        selection?.addRange(range);
        return;
      }
      offset = nextOffset;
    }
    range.selectNodeContents(composer);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function renderComposer(value: string, selectionStart: number, selectionEnd = selectionStart) {
    if (!composer) return;
    composer.innerHTML = highlightMarkdownInput(
      value,
      data.sharedChannel.members.map(({ name }) => name)
    );
    restoreComposerSelection(selectionStart, selectionEnd);
  }

  function updateMentionContext(cursor = composerSelection().end) {
    signalTyping(Boolean(messageBody.trim()));
    const match = messageBody.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) {
      mentionStart = -1;
      mentionQuery = '';
      return;
    }
    mentionStart = cursor - match[1].length - 1;
    mentionQuery = match[1];
    activeMentionIndex = 0;
  }

  function publishTyping(active: boolean) {
    const ready = realtimeSubscribed && realtimeSocket?.readyState === WebSocket.OPEN;
    if (ready) {
      realtimeSocket!.send(JSON.stringify({
        type: 'typing',
        channelId: data.sharedChannel.channel.id,
        active
      }));
    }
    lastTypingSignalAt = active && ready ? Date.now() : 0;
  }

  function signalTyping(active: boolean) {
    if (typingStopTimer) clearTimeout(typingStopTimer);
    if (!active) {
      if (lastTypingSignalAt) publishTyping(false);
      return;
    }
    if (Date.now() - lastTypingSignalAt > 1_000) publishTyping(true);
    typingStopTimer = setTimeout(() => publishTyping(false), 2_000);
  }

  type MarkdownFormat = 'bold' | 'italic' | 'strike' | 'link' | 'code' | 'quote' | 'list' | 'codeBlock';

  function setComposerSelection(value: string, selectionStart: number, selectionEnd: number) {
    messageBody = value;
    signalTyping(Boolean(value.trim()));
    mentionStart = -1;
    requestAnimationFrame(() => {
      composer?.focus();
      renderComposer(value, selectionStart, selectionEnd);
    });
  }

  function formatComposer(format: MarkdownFormat) {
    if (!composer) return;
    const { start, end } = composerSelection();
    const selected = messageBody.slice(start, end);
    const replace = (value: string, selectionStart: number, selectionEnd: number) => {
      setComposerSelection(
        `${messageBody.slice(0, start)}${value}${messageBody.slice(end)}`,
        start + selectionStart,
        start + selectionEnd
      );
    };
    const wrap = (before: string, after: string, placeholder: string) => {
      const content = selected || placeholder;
      replace(`${before}${content}${after}`, before.length, before.length + content.length);
    };

    if (format === 'bold') wrap('**', '**', 'bold text');
    else if (format === 'italic') wrap('_', '_', 'italic text');
    else if (format === 'strike') wrap('~~', '~~', 'strikethrough');
    else if (format === 'code') wrap('`', '`', 'code');
    else if (format === 'link') {
      const label = selected || 'link text';
      replace(`[${label}](url)`, label.length + 3, label.length + 6);
    } else if (format === 'codeBlock') {
      const content = selected || 'code';
      replace(`\`\`\`\n${content}\n\`\`\``, 4, 4 + content.length);
    } else {
      const prefix = format === 'quote' ? '> ' : '- ';
      const content = (selected || (format === 'quote' ? 'quote' : 'list item'))
        .split('\n')
        .map((line) => `${prefix}${line}`)
        .join('\n');
      replace(content, prefix.length, content.length);
    }
  }

  function selectMention(name: string) {
    if (!composer || mentionStart < 0) return;
    const cursor = composerSelection().end;
    messageBody = `${messageBody.slice(0, mentionStart)}@${name} ${messageBody.slice(cursor)}`;
    const nextCursor = mentionStart + name.length + 2;
    mentionStart = -1;
    mentionQuery = '';
    requestAnimationFrame(() => {
      composer?.focus();
      renderComposer(messageBody, nextCursor);
    });
  }

  function handleComposerInput() {
    if (!composer) return;
    const { end } = composerSelection();
    const value = (composer.textContent ?? '').slice(0, 4000);
    messageBody = value;
    renderComposer(value, Math.min(end, value.length));
    updateMentionContext(Math.min(end, value.length));
  }

  function handleComposerPaste(event: ClipboardEvent) {
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') ?? '');
  }

  function handleComposerKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && ['b', 'i'].includes(event.key.toLocaleLowerCase())) {
      event.preventDefault();
      formatComposer(event.key.toLocaleLowerCase() === 'b' ? 'bold' : 'italic');
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLocaleLowerCase() === 'x') {
      event.preventDefault();
      formatComposer('strike');
      return;
    }
    if (mentionMenuOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      activeMentionIndex = (activeMentionIndex + direction + mentionMatches.length) % mentionMatches.length;
      return;
    }
    if (mentionMenuOpen && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const selected = mentionMatches[activeMentionIndex] ?? mentionMatches[0];
      if (selected) selectMention(selected.name);
      return;
    }
    if (event.key === 'Escape' && mentionMenuOpen) {
      event.preventDefault();
      mentionStart = -1;
      return;
    }
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      document.execCommand('insertText', false, '\n');
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (messageBody.trim()) {
        (event.currentTarget as HTMLElement).closest('form')?.requestSubmit();
      }
    }
  }

  async function refreshActiveCall() {
    const response = await fetch(
      `/api/workspace/channel/${encodeURIComponent(data.sharedChannel.channel.id)}/call`
    );
    if (response.status === 401) {
      window.location.assign('/sign-in');
      return;
    }
    if (!response.ok) throw new Error('Call status could not be refreshed');
    const result = await response.json() as { call: typeof data.activeCall };
    activeCall = result.call;
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
          handoffs: typeof data.reconciliation.handoffs;
        };
        realtimeMessages = mergeChannelMessages(realtimeMessages, update.messages);
        realtimeRuns = applyChannelReconciliation(agentRuns, update);
        realtimeHandoffs = update.handoffs;
        const accountabilityResponse = await fetch(
          `/api/workspace/accountability?projectId=${encodeURIComponent(data.sharedChannel.project.id)}`
        );
        if (accountabilityResponse.ok) realtimeAccountability = await accountabilityResponse.json();
        await refreshActiveCall();
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
    const connect = async () => {
      if (stopped) return;
      const ticketResponse = await fetch('/api/realtime-ticket', { method: 'POST' });
      if (ticketResponse.status === 401) {
        window.location.assign('/sign-in');
        return;
      }
      if (!ticketResponse.ok) {
        reconnectTimer = setTimeout(connect, 1_000);
        return;
      }
      const { ticket } = await ticketResponse.json() as { ticket: string };
      if (stopped) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const websocket = new WebSocket(
        `${protocol}//${window.location.host}/realtime?ticket=${encodeURIComponent(ticket)}`
      );
      realtimeSocket = websocket;
      websocket.addEventListener('message', async ({ data: payload }) => {
        let message: {
          type?: string;
          channelId?: string;
          memberId?: string;
          memberName?: string;
          active?: boolean;
        };
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
          realtimeSubscribed = true;
          // Close the fetch-to-subscribe race with one final durable read.
          void requestReconciliation();
        } else if (
          message.type === 'typing'
          && message.channelId === data.sharedChannel.channel.id
          && message.memberId
          && message.memberName
        ) {
          if (message.active) {
            humanTypers = {
              ...humanTypers,
              [message.memberId]: { name: message.memberName, expiresAt: Date.now() + 4_000 }
            };
          } else if (humanTypers[message.memberId]) {
            const { [message.memberId]: _removed, ...remaining } = humanTypers;
            humanTypers = remaining;
          }
        }
      });
      websocket.addEventListener('close', () => {
        if (realtimeSocket === websocket) {
          realtimeSocket = undefined;
          realtimeSubscribed = false;
        }
        humanTypers = {};
        if (!stopped) reconnectTimer = setTimeout(() => void connect(), 1_000);
      });
    };
    const wake = () => void requestReconciliation();
    const visibilityWake = () => {
      if (document.visibilityState === 'visible') wake();
    };
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
    document.addEventListener('visibilitychange', visibilityWake);
    const typingExpiryTimer = setInterval(() => {
      const now = Date.now();
      const active = Object.fromEntries(
        Object.entries(humanTypers).filter(([, typer]) => typer.expiresAt > now)
      );
      if (Object.keys(active).length !== Object.keys(humanTypers).length) humanTypers = active;
    }, 1_000);
    void connect();

    return () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (typingStopTimer) clearTimeout(typingStopTimer);
      clearInterval(typingExpiryTimer);
      realtimeSocket?.close();
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
      document.removeEventListener('visibilitychange', visibilityWake);
    };
  });

  async function signOut() {
    await fetch('/api/auth/sign-out', { method: 'POST' });
    window.location.assign('/sign-in');
  }

  async function manageCall(action: 'start' | 'join' | 'end') {
    callBusy = true;
    callMessage = '';
    const embedded = data.jitsiEmbeddingEnabled && action !== 'end';
    const callWindow = action === 'end' || embedded ? null : window.open('', '_blank');
    try {
      const response = await fetch(
        `/api/workspace/channel/${encodeURIComponent(data.sharedChannel.channel.id)}/call`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action })
        }
      );
      const result = await response.json() as {
        call: typeof data.activeCall;
        message?: string;
      };
      if (!response.ok) throw new Error(result.message ?? 'Call action failed');
      activeCall = result.call;
      if (result.call && embedded) {
        callView = 'inline';
      } else if (result.call && callWindow) {
        callWindow.opener = null;
        callWindow.location.href = result.call.url;
      } else if (result.call) {
        callMessage = 'Your browser blocked the Jitsi tab. Allow pop-ups for Relay and try again.';
      } else {
        callView = 'closed';
        callWindow?.close();
      }
    } catch (error) {
      callWindow?.close();
      callMessage = error instanceof Error ? error.message : String(error);
    } finally {
      callBusy = false;
    }
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
          confirmNoAppBypass: githubNoBypassConfirmed,
          releaseBranches: githubReleaseBranches
            .split(',')
            .map((branch) => branch.trim())
            .filter(Boolean)
        } : action === 'verify' ? {
          action,
          confirmNoAppBypass: githubNoBypassConfirmed
        } : { action })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'GitHub repository action failed');
      githubNoBypassConfirmed = false;
      await invalidateAll();
    } catch (error) {
      githubMessage = error instanceof Error ? error.message : String(error);
    } finally {
      githubBusy = false;
    }
  }

  async function inviteMember() {
    invitationBusy = true;
    invitationMessage = '';
    invitationPath = '';
    try {
      const response = await fetch('/api/workspace/invitations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: invitationEmail })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Invitation failed');
      invitationPath = result.invitation.invitationPath;
      invitationMessage = `Invitation created for ${result.invitation.email}.`;
      invitationEmail = '';
    } catch (error) {
      invitationMessage = error instanceof Error ? error.message : String(error);
    } finally {
      invitationBusy = false;
    }
  }

  function editAgent(agent: (typeof data.agentConfiguration.agents)[number]) {
    editingAgentId = agent.id;
    agentName = agent.name;
    agentType = agent.agentType;
    agentRole = agent.roleLabel;
    agentInstructions = agent.instructions;
    agentParticipation = agent.participationMode;
    agentTopics = agent.ambientTriggers.join(', ');
    agentReplyMode = agent.replyMode;
    agentEnabled = agent.enabled;
  }

  function resetAgentForm() {
    editingAgentId = null;
    agentName = '';
    agentType = 'general';
    agentRole = '';
    agentInstructions = '';
    agentParticipation = 'ambient';
    agentTopics = '';
    agentReplyMode = 'adaptive';
    agentEnabled = true;
  }

  async function saveAgent() {
    agentBusy = true;
    agentMessage = '';
    try {
      const response = await fetch(editingAgentId
        ? `/api/workspace/agents/${encodeURIComponent(editingAgentId)}`
        : '/api/workspace/agents', {
        method: editingAgentId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: agentName,
          agentType,
          roleLabel: agentRole,
          instructions: agentInstructions,
          participationMode: agentParticipation,
          ambientTriggers: agentTopics.split(',').map((topic) => topic.trim()).filter(Boolean),
          replyMode: agentReplyMode,
          enabled: agentEnabled
        })
      });
      const result = response.status === 204 ? {} : await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Agent configuration failed');
      agentMessage = editingAgentId ? 'Agent updated.' : 'Agent added.';
      resetAgentForm();
      await invalidateAll();
    } catch (error) {
      agentMessage = error instanceof Error ? error.message : String(error);
    } finally {
      agentBusy = false;
    }
  }

  async function instantiateTemplate() {
    if (!selectedAgentTemplate) return;
    agentBusy = true;
    agentMessage = '';
    try {
      const response = await fetch('/api/workspace/agent-templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: selectedAgentTemplate.key, availableCapabilities: [] })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Agent template could not be instantiated');
      agentMessage = result.disabledCapabilities.length > 0
        ? `Agent added with unavailable capabilities disabled: ${result.disabledCapabilities.join(', ')}.`
        : 'Agent added from template.';
      agentTemplateKey = '';
      await invalidateAll();
    } catch (error) {
      agentMessage = error instanceof Error ? error.message : String(error);
    } finally {
      agentBusy = false;
    }
  }

  async function deleteMessage(message: (typeof data.sharedChannel.messages)[number]) {
    if (!canDeleteMessage(message)) return;
    if (!window.confirm('Delete this message? Replies and work history will be preserved.')) return;
    const response = await fetch(`/api/workspace/messages/${encodeURIComponent(message.id)}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      window.alert(result.message ?? 'Message could not be deleted');
      return;
    }
    await requestReconciliation();
    await invalidateAll();
  }

  async function cancelHandoff(handoffId: string) {
    const response = await fetch(
      `/api/workspace/handoffs/${encodeURIComponent(handoffId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      window.alert(result.message ?? 'Agent handoff could not be cancelled');
      return;
    }
    await requestReconciliation();
  }

  async function decidePlan(planId: string, action: 'approve' | 'reject' | 'pause' | 'cancel') {
    const response = await fetch(`/api/workspace/coordination/${encodeURIComponent(planId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action })
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      window.alert(result.message ?? 'Coordination plan could not be updated');
      return;
    }
    await invalidateAll();
  }

  async function switchWorkspace(workspaceId: string) {
    if (!workspaceId || workspaceId === data.sharedChannel.workspace.id) return;
    workspaceBusy = true;
    workspaceMessage = '';
    workspaceNotice = '';
    try {
      const response = await fetch('/api/workspaces', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId })
      });
      const result = response.status === 204 ? {} : await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Workspace could not be selected');
      window.location.assign('/');
    } catch (error) {
      workspaceMessage = error instanceof Error ? error.message : String(error);
      workspaceBusy = false;
    }
  }

  function beginWorkspaceRename(workspace: (typeof data.workspaces)[number]) {
    editingWorkspaceId = workspace.id;
    editingWorkspaceName = workspace.name;
    workspaceMessage = '';
    workspaceNotice = '';
  }

  function cancelWorkspaceRename() {
    editingWorkspaceId = null;
    editingWorkspaceName = '';
  }

  async function saveWorkspaceName(workspaceId: string) {
    workspaceBusy = true;
    workspaceMessage = '';
    workspaceNotice = '';
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: editingWorkspaceName })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Workspace could not be renamed');
      cancelWorkspaceRename();
      workspaceNotice = 'Workspace renamed.';
      await invalidateAll();
    } catch (error) {
      workspaceMessage = error instanceof Error ? error.message : String(error);
    } finally {
      workspaceBusy = false;
    }
  }

  async function addWorkspace() {
    workspaceBusy = true;
    workspaceMessage = '';
    workspaceNotice = '';
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newWorkspaceName })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? 'Workspace could not be created');
      window.location.assign('/');
    } catch (error) {
      workspaceMessage = error instanceof Error ? error.message : String(error);
      workspaceBusy = false;
    }
  }

  async function correctIntent(messageId: string, intent: string) {
    const response = await fetch(`/api/workspace/messages/${encodeURIComponent(messageId)}/intent`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent })
    });
    const result = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      agentMessage = result?.message ?? 'Routing interpretation could not be corrected.';
      return;
    }
    await invalidateAll();
  }

  async function setMemoryLifecycle(memoryId: string, lifecycle: 'archived' | 'deleted') {
    const response = await fetch('/api/workspace/memory', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memoryId, lifecycle })
    });
    if (!response.ok) agentMessage = (await response.json()).message ?? 'Memory could not be updated.';
    else await invalidateAll();
  }

  async function correctMemory(memory: (typeof accountability.memory)[number]) {
    const statement = window.prompt('Correct this Project memory entry', memory.statement)?.trim();
    if (!statement || statement === memory.statement) return;
    const response = await fetch('/api/workspace/memory', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: data.sharedChannel.project.id, type: memory.type, statement,
        sourceReferences: memory.sourceReferences, supersedesId: memory.id
      })
    });
    if (!response.ok) agentMessage = (await response.json()).message ?? 'Memory correction could not be saved.';
    else await invalidateAll();
  }

  async function submitFeedback(outcomeType: string, outcomeId: string, rating: string) {
    const response = await fetch('/api/workspace/accountability', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: data.sharedChannel.project.id, outcomeType, outcomeId, rating })
    });
    if (!response.ok) agentMessage = (await response.json()).message ?? 'Feedback could not be saved.';
  }

  async function editPlan(plan: (typeof accountability.plans)[number]) {
    const editable = {
      goal: plan.goal, constraints: plan.constraints, allowParallel: plan.allowParallel,
      budget: {
        maxParticipants: plan.budget.maxParticipants, maxHandoffs: plan.budget.maxHandoffs,
        maxDepth: plan.budget.maxDepth, maxAgentRuns: plan.budget.maxAgentRuns,
        maxElapsedSeconds: plan.budget.maxElapsedSeconds,
        ...(plan.budget.providerUsage.limit === null ? {} : { providerUsageLimit: plan.budget.providerUsage.limit })
      },
      steps: plan.steps.map((step) => ({
        key: step.key, agentId: step.agentId, instruction: step.instruction,
        dependencies: step.dependencies, expectedOutput: step.expectedOutput,
        ...(step.artifactId ? { artifactId: step.artifactId } : {})
      }))
    };
    const source = window.prompt('Edit the proposed plan JSON', JSON.stringify(editable, null, 2));
    if (!source) return;
    let edited;
    try { edited = JSON.parse(source); } catch { agentMessage = 'Plan JSON is invalid.'; return; }
    const response = await fetch(`/api/workspace/coordination/${encodeURIComponent(plan.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'edit', plan: edited })
    });
    if (!response.ok) agentMessage = (await response.json()).message ?? 'Plan could not be edited.';
    else await invalidateAll();
  }

  function safeEvidenceUrl(reference: string) {
    try {
      const url = new URL(reference);
      return url.protocol === 'https:' ? url.toString() : null;
    } catch { return null; }
  }
</script>

{#snippet agentMentionStatus(message: (typeof data.sharedChannel.messages)[number])}
  {@const handoff = handoffForSource(message.id)}
  {@const plan = planForSource(message.id)}
  {@const steering = steeringForSource(message.id)}
  {#if message.routingDecision}
    <p class="mt-2 flex flex-wrap items-center gap-2 text-xs text-base-content/55">
      <span class="badge badge-ghost badge-xs">{message.routingDecision.intent.replaceAll('_', ' ')}</span>
      <span>{Math.round(message.routingDecision.confidence * 100)}% · {message.routingDecision.rationale}</span>
      {#if message.routingDecision.correctedAt}<span class="text-info">Pilot corrected</span>{/if}
      {#if message.routingDecision.intent === 'engineering_delegation' && !message.routingDecision.correctedAt}
        <button class="btn btn-primary btn-xs" type="button" onclick={() => void correctIntent(message.id, 'engineering_delegation')}>Confirm engineering work</button>
        <button class="btn btn-ghost btn-xs" type="button" onclick={() => void correctIntent(message.id, 'conversation')}>Treat as conversation</button>
      {/if}
    </p>
  {/if}
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
  {:else if message.agentMention?.status === 'conversation'
    && ['queued', 'failed'].includes(message.agentMention.turnStatus)}
    <p class="mt-2 text-xs text-base-content/60" role="status">
      {message.agentMention.turnStatus === 'queued'
        ? `${mentionedAgentName(message.agentMention.agentId)} will reply shortly.`
        : `${mentionedAgentName(message.agentMention.agentId)} could not reply.`}
    </p>
  {:else if message.agentMention?.status === 'rejected'}
    <p class="mt-2 text-xs text-warning" role="status">{message.agentMention.reason}</p>
  {/if}
  {#if handoff}
    <div class="mt-2 border-l-2 border-primary/45 pl-3 text-xs" role="status">
      <div class="flex flex-wrap items-center gap-2">
        <span class="badge badge-sm rounded-sm border-primary/35 bg-primary/8 text-primary">
          Handoff · {handoff.status}
        </span>
        <strong>{handoff.sourceAgentName} → {handoff.targetAgentName}</strong>
        <span class="text-base-content/55">{handoff.summary}</span>
        {#if handoff.status === 'queued'}
          <button
            class="btn btn-ghost btn-xs ml-auto"
            type="button"
            onclick={() => void cancelHandoff(handoff.id)}
          >Cancel</button>
        {/if}
      </div>
      <p class="mt-1 text-base-content/55">{handoff.question}</p>
    </div>
  {/if}
  {#if steering}
    <p class="mt-2 text-xs text-info" role="status">
      Steering {steering.status}: {steering.guidance}
    </p>
  {/if}
  {#if plan}
    <div class="mt-3 border border-primary/25 bg-primary/5 p-3 text-xs" role="status">
      <div class="flex flex-wrap items-center gap-2">
        <span class="badge badge-sm badge-primary">Plan · {plan.status}</span>
        <strong>{plan.goal}</strong>
      </div>
      <p class="mt-1 text-base-content/55">
        {plan.steps.length} steps · {plan.allowParallel ? 'parallel when dependencies allow' : 'sequential'}
        · {plan.budget.maxParticipants} participants max
        · {plan.budget.consumedHandoffs}/{plan.budget.maxHandoffs} handoffs
        · depth {plan.budget.maxDepth} · {plan.budget.maxAgentRuns} AgentRuns max
        · {plan.budget.maxElapsedSeconds}s max
        · provider usage {plan.budget.providerUsage.known ? `${plan.budget.providerUsage.consumed}/${plan.budget.providerUsage.limit ?? '∞'}` : 'unknown'}
      </p>
      <ol class="mt-2 list-inside list-decimal space-y-1">
        {#each plan.steps as step}
          <li>
            {step.agentName}: {step.instruction}
            <span class="text-base-content/45">
              ({step.status}; depends on {step.dependencies.length ? step.dependencies.join(', ') : 'nothing'}; expects {step.expectedOutput.replaceAll('_', ' ')})
            </span>
          </li>
        {/each}
      </ol>
      {#if plan.status === 'proposed'}
        <div class="mt-2 flex gap-2">
          <button class="btn btn-primary btn-xs" type="button" onclick={() => void decidePlan(plan.id, 'approve')}>Approve</button>
          <button class="btn btn-ghost btn-xs" type="button" onclick={() => void editPlan(plan)}>Edit</button>
          <button class="btn btn-ghost btn-xs" type="button" onclick={() => void decidePlan(plan.id, 'reject')}>Reject</button>
        </div>
      {:else if ['approved', 'active'].includes(plan.status)}
        <div class="mt-2 flex gap-2">
          <button class="btn btn-ghost btn-xs" type="button" onclick={() => void decidePlan(plan.id, 'pause')}>Pause</button>
          <button class="btn btn-ghost btn-xs text-error" type="button" onclick={() => void decidePlan(plan.id, 'cancel')}>Cancel</button>
        </div>
      {/if}
      {#if ['completed', 'rejected', 'cancelled', 'failed'].includes(plan.status)}
        <div class="mt-2 flex flex-wrap gap-1">
          {#each ['useful', 'incorrect', 'incomplete', 'unnecessarily_delegated'] as rating}
            <button class="btn btn-ghost btn-xs" type="button" onclick={() => void submitFeedback('coordination_plan', plan.id, rating)}>{rating.replaceAll('_', ' ')}</button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
{/snippet}

<svelte:head>
  <title>#{data.sharedChannel.channel.name} · Relay</title>
  <meta name="description" content="Relay shared engineering agent workspace" />
</svelte:head>

<main class="relay-shell grid min-h-screen lg:grid-cols-[16rem_minmax(0,1fr)]">
  <aside class="border-white/12 bg-[#0b0c0e] border-b px-4 py-5 lg:sticky lg:top-0 lg:z-30 lg:flex lg:h-screen lg:flex-col lg:overflow-visible lg:border-r lg:border-b-0 lg:px-5">
    <div class="flex items-center gap-3">
      <BrandMark />
    </div>

    <div class="eyebrow mt-10">Workspace</div>
    <div class="mt-3 border-l-2 border-primary pl-3">
      <select
        class="workspace-select w-full bg-transparent text-sm font-medium text-[#f1efe8] outline-none"
        value={data.sharedChannel.workspace.id}
        aria-label="Active Workspace"
        disabled={workspaceBusy}
        onchange={(event) => void switchWorkspace(event.currentTarget.value)}
      >
        {#each data.workspaces as workspace (workspace.id)}
          <option value={workspace.id}>{workspace.name}</option>
        {/each}
      </select>
      <div class="mt-1 truncate text-[0.65rem] text-base-content/32">{data.sharedChannel.project.name}</div>
    </div>
    <div class="eyebrow mt-8">Channels</div>
    <nav aria-label="Project channels" class="mt-2">
      <a class="flex items-center gap-2 border-y border-white/10 py-2.5 text-sm font-medium text-white" href="/">
        <span class="text-primary">#</span> {data.sharedChannel.channel.name}
        <span class="ml-auto signal-dot"></span>
      </a>
    </nav>

    <div class="eyebrow mt-8">Members</div>
    <ul class="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-3 md:grid-cols-1">
      {#each sidebarMembers as member}
        <li class="agent-status group relative">
          <button
            class="flex w-full items-center gap-3 border-b border-white/6 py-2.5 text-left text-sm outline-none transition hover:text-primary focus-visible:ring-1 focus-visible:ring-primary"
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
                    ? 'Ready for relevant conversation or assigned work in this Project.'
                    : 'A ready Codex connection is required before this Agent can respond.')
                  : `${member.roleLabel} is ${member.status}.`}
              </span>
            </div>
          {/if}
        </li>
      {/each}
    </ul>

    <div class="eyebrow mt-8">Agent workload</div>
    <div class="mt-2 grid grid-cols-2 gap-1">
      <select class="select select-xs bg-base-300" aria-label="Filter workload by Agent" bind:value={inboxAgentFilter}>
        <option value="all">All Agents</option>
        {#each data.agentConfiguration.agents as agent (agent.id)}<option value={agent.id}>{agent.name}</option>{/each}
      </select>
      <select class="select select-xs bg-base-300" aria-label="Filter workload by state" bind:value={inboxStateFilter}>
        <option value="all">All states</option>
        {#each ['queued', 'active', 'waiting', 'blocked', 'review_ready', 'completed'] as state}<option value={state}>{state.replaceAll('_', ' ')}</option>{/each}
      </select>
      <select class="select select-xs bg-base-300" aria-label="Filter workload by urgency" bind:value={inboxUrgencyFilter}>
        <option value="all">All urgency</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
      </select>
      <label class="flex items-center gap-1 text-[0.65rem]"><input type="checkbox" class="checkbox checkbox-xs" bind:checked={inboxHumanOnly} /> Human action</label>
    </div>
    <p class="mt-1 text-[0.6rem] text-base-content/35">Project: {data.sharedChannel.project.name}</p>
    <ul class="mt-1 max-h-40 space-y-1 overflow-y-auto text-xs text-base-content/55">
      {#each filteredInbox as item (item.id)}
        <li class="border-b border-white/6 py-1.5">
          <a class="block hover:text-primary" href={`#message-${item.sourceMessageId}`}>
            <span class:badge-warning={item.requiresHumanAction} class="badge badge-ghost badge-xs">{item.urgency}</span>
            <strong>{item.agentName}</strong> · {item.state.replaceAll('_', ' ')}
            <span class="block truncate">{item.summary}</span>
          </a>
        </li>
      {:else}
        <li class="py-2 text-base-content/35">No matching work.</li>
      {/each}
    </ul>

    {#if accountability.findings.length > 0}
      <div class="eyebrow mt-6">Findings</div>
      <ul class="mt-2 max-h-52 space-y-2 overflow-y-auto text-xs">
        {#each accountability.findings as finding (finding.id)}
          <li class="border border-white/8 p-2">
            <strong>{finding.summary}</strong>
            <span class="ml-1 text-base-content/45">{Math.round(finding.confidence * 100)}% confidence · {finding.evidenceStrength}</span>
            {#if finding.assumptions.length}<p class="mt-1 text-warning">Assumptions: {finding.assumptions.join('; ')}</p>{/if}
            {#if finding.openQuestions.length}<p class="mt-1 text-info">Open: {finding.openQuestions.join('; ')}</p>{/if}
            <ul class="mt-1 space-y-1">
              {#each finding.evidence as evidence}
                {@const evidenceUrl = safeEvidenceUrl(evidence.stableReference)}
                <li>
                  {#if evidence.type === 'external' && evidenceUrl}<a class="link link-primary" href={evidenceUrl} target="_blank" rel="noopener noreferrer">{evidence.title}</a>{:else}<span>{evidence.title} · {evidence.stableReference}</span>{/if}
                  <span class="block text-base-content/45">{evidence.claim}</span>
                </li>
              {/each}
            </ul>
            <div class="mt-1 flex flex-wrap gap-1">
              {#each ['useful', 'incorrect', 'incomplete', 'unnecessarily_delegated'] as rating}
                <button class="btn btn-ghost btn-xs" type="button" onclick={() => void submitFeedback('finding', finding.id, rating)}>{rating.replaceAll('_', ' ')}</button>
              {/each}
            </div>
          </li>
        {/each}
      </ul>
    {/if}

    {#if accountability.memory.length > 0}
      <div class="eyebrow mt-6">Project memory</div>
      <ul class="mt-2 max-h-40 space-y-2 overflow-y-auto text-xs">
        {#each accountability.memory as memory (memory.id)}
          <li class="border border-white/8 p-2">
            <span class="badge badge-ghost badge-xs">{memory.type} · {memory.lifecycle}</span>
            <p class="mt-1">{memory.statement}</p>
            <p class="mt-1 truncate text-base-content/35">Sources: {memory.sourceReferences.join(', ')}</p>
            {#if memory.lifecycle === 'active'}
              <div class="mt-1 flex gap-1">
                <button class="btn btn-ghost btn-xs" type="button" onclick={() => void correctMemory(memory)}>Correct / supersede</button>
                <button class="btn btn-ghost btn-xs" type="button" onclick={() => void setMemoryLifecycle(memory.id, 'archived')}>Archive</button>
                <button class="btn btn-ghost btn-xs text-error" type="button" onclick={() => void setMemoryLifecycle(memory.id, 'deleted')}>Delete</button>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="mt-8 border-t border-white/10 pt-3 lg:mt-auto">
      <button
        class="account-trigger flex w-full items-center gap-3 py-2 text-left outline-none transition hover:text-primary focus-visible:ring-1 focus-visible:ring-primary"
        type="button"
        popovertarget="account-menu"
        aria-label={`Open account menu for ${data.currentUser.name}`}
      >
        <span class="member-avatar shrink-0">{initials(data.currentUser.name)}</span>
        <span class="min-w-0 flex-1">
          <strong class="block truncate text-sm font-medium text-[#f1efe8]">{data.currentUser.name}</strong>
          <span class="block truncate text-[0.68rem] capitalize text-base-content/38">Workspace {data.currentUser.role}</span>
        </span>
        <svg class="size-4 text-base-content/35" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" aria-hidden="true">
          <path d="m6 8 4 4 4-4" />
        </svg>
      </button>
    </div>
  </aside>

  <section class="flex min-w-0 flex-col bg-[#101113]">
    <header class="border-white/12 sticky top-0 z-20 flex items-center justify-between border-b bg-[#101113] px-5 py-4 sm:px-8">
      <div>
        <div class="eyebrow mb-1">Shared agent channel</div>
        <h1 class="font-display text-lg font-medium tracking-[-0.025em] text-[#f1efe8]"># {data.sharedChannel.channel.name}</h1>
      </div>
      <div class="flex items-center gap-2 sm:gap-3">
        {#if activeCall}
          <div class="hidden text-right md:block">
            <div class="flex items-center justify-end gap-1.5 text-xs font-semibold text-success">
              <span class="size-1.5 rounded-full bg-success"></span>
              Call active
            </div>
            <div class="text-[0.66rem] text-base-content/40">
              {activeCall.participants.length} joined · started by {activeCall.startedBy.name}
            </div>
          </div>
          <button
            class="btn btn-primary btn-sm gap-2"
            type="button"
            disabled={callBusy}
            title={data.jitsiEmbeddingEnabled ? 'Join embedded Jitsi call' : 'Join Jitsi call in a new tab'}
            onclick={() => void manageCall('join')}
          >
            <svg class="size-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" aria-hidden="true">
              <rect x="3" y="5" width="10" height="10" rx="1.5" />
              <path d="m13 8 4-2v8l-4-2" />
            </svg>
            <span class="hidden sm:inline">Join</span>
          </button>
          {#if activeCall.canEnd}
            <button
              class="btn btn-ghost btn-sm px-2 text-base-content/50 hover:text-error"
              type="button"
              disabled={callBusy}
              title="End call"
              aria-label="End call"
              onclick={() => void manageCall('end')}
            >
              <svg class="size-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" aria-hidden="true">
                <path d="M4 11c3.8-2.7 8.2-2.7 12 0" />
                <path d="m4 11 2 3 2-2m8-1-2 3-2-2" />
              </svg>
            </button>
          {/if}
        {:else}
          <button
            class="btn btn-ghost btn-sm gap-2 border border-white/12 px-3"
            type="button"
            disabled={callBusy}
            title={data.jitsiEmbeddingEnabled ? 'Start embedded Jitsi call' : 'Start a Jitsi call in a new tab'}
            onclick={() => void manageCall('start')}
          >
            <svg class="size-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" aria-hidden="true">
              <rect x="3" y="5" width="10" height="10" rx="1.5" />
              <path d="m13 8 4-2v8l-4-2" />
            </svg>
            <span class="hidden sm:inline">Start call</span>
          </button>
        {/if}
      </div>
    </header>

    {#if data.jitsiEmbeddingEnabled && activeCall && callView !== 'closed'}
      <section
        class:fixed={callView === 'floating'}
        class:bottom-4={callView === 'floating'}
        class:right-4={callView === 'floating'}
        class:z-50={callView === 'floating'}
        class:w-[min(28rem,calc(100vw-2rem))]={callView === 'floating'}
        class:shadow-2xl={callView === 'floating'}
        class="border-b border-white/12 bg-[#17181b]"
        aria-label="Jitsi call"
      >
        <div class="flex items-center justify-between border-b border-white/10 px-3 py-2">
          <div class="flex items-center gap-2 text-xs font-semibold text-[#f1efe8]">
            <span class="size-1.5 rounded-full bg-success"></span>
            Channel call
          </div>
          <div class="flex items-center gap-1">
            <a
              class="btn btn-ghost btn-xs px-2"
              href={activeCall.url}
              target="_blank"
              rel="noreferrer"
              title="Open in a new tab"
              aria-label="Open call in a new tab"
            >
              <svg class="size-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" aria-hidden="true">
                <path d="M8 4H4v12h12v-4M11 4h5v5M16 4l-7 7" />
              </svg>
            </a>
            <button
              class="btn btn-ghost btn-xs px-2"
              type="button"
              title={callView === 'floating' ? 'Show call inline' : 'Float call over chat'}
              aria-label={callView === 'floating' ? 'Show call inline' : 'Float call over chat'}
              onclick={() => callView = callView === 'floating' ? 'inline' : 'floating'}
            >
              <svg class="size-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
                <rect x="10" y="9" width="5.5" height="4.5" rx=".7" />
              </svg>
            </button>
            <button
              class="btn btn-ghost btn-xs px-2"
              type="button"
              title="Hide call"
              aria-label="Hide call"
              onclick={() => callView = 'closed'}
            >
              <svg class="size-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.6" aria-hidden="true">
                <path d="m5 5 10 10M15 5 5 15" />
              </svg>
            </button>
          </div>
        </div>
        <div class:h-[19rem]={callView === 'floating'} class:h-[min(62vh,44rem)]={callView === 'inline'}>
          <JitsiCall meetingUrl={activeCall.url} displayName={data.currentUser.name} />
        </div>
      </section>
    {/if}

    {#if callMessage}
      <div class="border-b border-error/25 bg-error/8 px-5 py-2 text-xs text-error sm:px-8" role="alert">
        {callMessage}
      </div>
    {/if}

    <div class="flex-1 px-4 py-7 sm:px-8 sm:py-10">
      {#if roots.length === 0}
        <div class="mx-auto max-w-xl py-16 text-center">
          <div class="mx-auto flex size-16 items-center justify-center border border-white/12"><BrandMark compact /></div>
          <div class="eyebrow mt-6">Channel ready</div>
          <h2 class="font-display mt-2 text-2xl font-semibold tracking-[-0.035em] text-white">Start the shared conversation</h2>
          <p class="mx-auto mt-3 max-w-md text-sm leading-6 text-base-content/50">Your team and specialist Agents are here. Messages remain in this Project after reload.</p>
        </div>
      {:else}
        <div class="mx-auto max-w-4xl space-y-3" aria-live="polite">
          {#each roots as message, rootIndex (message.id)}
            {@const threadReplies = repliesFor(message.id)}
            {@const threadOpen = openThreadIds.includes(message.id)}
            {#if rootIndex === 0 || calendarDateKey(roots[rootIndex - 1].createdAt) !== calendarDateKey(message.createdAt)}
              <div class="date-divider" role="separator" aria-label={formatDateDivider(message.createdAt)}>
                <span>{formatDateDivider(message.createdAt)}</span>
              </div>
            {/if}
            <article id={`message-${message.id}`} class="border-b border-white/8 p-4 sm:p-5">
              <div class="message-row relative flex gap-3 pr-10">
                <div class="message-actions" aria-label="Message actions">
                  <button
                    class="message-action"
                    type="button"
                    aria-label={`Reply to ${message.author.name}`}
                    title="Reply"
                    onclick={() => beginReply(message.id)}
                  >
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" aria-hidden="true">
                      <path d="m8 5-5 5 5 5" />
                      <path d="M4 10h6.5c3.6 0 5.5 1.7 5.5 5" />
                    </svg>
                  </button>
                  {#if canDeleteMessage(message)}
                    <button
                      class="message-action message-action--danger"
                      type="button"
                      aria-label={`Delete message from ${message.author.name}`}
                      title="Delete message"
                      onclick={() => void deleteMessage(message)}
                    >
                      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" aria-hidden="true">
                        <path d="M4 6h12M8 3h4l1 3H7l1-3Z" />
                        <path d="m6 6 .6 10h6.8L14 6M8.5 9v4m3-4v4" />
                      </svg>
                    </button>
                  {/if}
                </div>
                <div class:agent-avatar={message.author.kind === 'agent'} class="member-avatar shrink-0">{initials(message.author.name)}</div>
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-baseline gap-2">
                    <strong>{message.author.name}</strong>
                    <span class="text-xs text-base-content/45">{message.author.roleLabel} · {formatTime(message.createdAt)}</span>
                  </div>
                  <div class:message-deleted={message.deletedAt} class="mt-1 text-[0.925rem] leading-6 text-base-content/85">
                    <MarkdownMessage body={message.body} mentionNames={data.sharedChannel.members.map(({ name }) => name)} />
                  </div>
                  {@render agentMentionStatus(message)}
                </div>
              </div>

              {#if threadReplies.length > 0}
                <button
                  class="thread-summary ml-11 mt-2 sm:ml-12"
                  type="button"
                  aria-expanded={threadOpen}
                  onclick={() => toggleThread(message.id)}
                >
                  <span class="flex -space-x-1.5" aria-hidden="true">
                    {#each threadReplies.slice(-3) as reply (reply.id)}
                      <span class:agent-avatar={reply.author.kind === 'agent'} class="member-avatar thread-avatar">{initials(reply.author.name)}</span>
                    {/each}
                  </span>
                  <strong>{threadOpen ? 'Hide' : `${threadReplies.length} ${threadReplies.length === 1 ? 'reply' : 'replies'}`}</strong>
                  <span class="text-base-content/35">Last reply {formatTime(threadReplies.at(-1)!.createdAt)}</span>
                  <svg class:rotate-180={threadOpen} viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" aria-hidden="true">
                    <path d="m7 5 5 5-5 5" />
                  </svg>
                </button>
              {/if}

              {#if threadOpen && threadReplies.length > 0}
                <div class="ml-5 mt-3 space-y-3 border-l border-primary/20 pl-5 sm:ml-12">
                  {#each threadReplies as reply, replyIndex (reply.id)}
                    {#if calendarDateKey(reply.createdAt) !== calendarDateKey(replyIndex === 0 ? message.createdAt : threadReplies[replyIndex - 1].createdAt)}
                      <div class="thread-date-divider" role="separator" aria-label={formatDateDivider(reply.createdAt)}>
                        <span>{formatDateDivider(reply.createdAt)}</span>
                      </div>
                    {/if}
                    <div class="message-row relative flex gap-3 py-1 pr-10">
                      <div class="message-actions" aria-label="Message actions">
                        <button
                          class="message-action"
                          type="button"
                          aria-label={`Reply to ${reply.author.name}`}
                          title="Reply"
                          onclick={() => beginReply(message.id)}
                        >
                          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" aria-hidden="true">
                            <path d="m8 5-5 5 5 5" />
                            <path d="M4 10h6.5c3.6 0 5.5 1.7 5.5 5" />
                          </svg>
                        </button>
                        {#if canDeleteMessage(reply)}
                          <button
                            class="message-action message-action--danger"
                            type="button"
                            aria-label={`Delete reply from ${reply.author.name}`}
                            title="Delete message"
                            onclick={() => void deleteMessage(reply)}
                          >
                            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" aria-hidden="true">
                              <path d="M4 6h12M8 3h4l1 3H7l1-3Z" />
                              <path d="m6 6 .6 10h6.8L14 6M8.5 9v4m3-4v4" />
                            </svg>
                          </button>
                        {/if}
                      </div>
                      <div class:agent-avatar={reply.author.kind === 'agent'} class="member-avatar member-avatar-small shrink-0">{initials(reply.author.name)}</div>
                      <div class="min-w-0 flex-1">
                        <div class="flex flex-wrap items-baseline gap-2">
                          <strong class="text-sm">{reply.author.name}</strong>
                          <span class="text-xs text-base-content/45">{formatTime(reply.createdAt)}</span>
                        </div>
                        <div class:message-deleted={reply.deletedAt} class="mt-1 text-sm leading-6">
                          <MarkdownMessage body={reply.body} mentionNames={data.sharedChannel.members.map(({ name }) => name)} />
                        </div>
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

    <div class="sticky bottom-0 z-20 border-t border-white/10 bg-[#101113] px-4 py-4 sm:px-8 sm:py-5">
      <form
        method="POST"
        action="?/send"
        class="mx-auto max-w-3xl"
        use:enhance={() => async ({ result, update }) => {
          await update({ reset: true });
          if (result.type === 'success') {
            signalTyping(false);
            replyToId = null;
            messageBody = '';
            mentionStart = -1;
            if (composer) composer.textContent = '';
          }
          await invalidateAll();
        }}
      >
        <input type="hidden" name="channelId" value={data.sharedChannel.channel.id} />
        <input type="hidden" name="parentMessageId" value={replyToId ?? ''} />
        <input type="hidden" name="submissionId" value={data.messageSubmissionId} />
        <input type="hidden" name="body" value={messageBody} />
        {#if replyToId}
          <div class="mb-2 flex items-center justify-between rounded-lg bg-base-200 px-3 py-2 text-xs">
            <span>Replying to a channel Message</span>
            <button class="btn btn-ghost btn-xs" type="button" onclick={() => (replyToId = null)}>Cancel</button>
          </div>
        {/if}
        {#if typingNames.length > 0}
          <p class="mb-1.5 text-xs text-base-content/50" role="status" aria-live="polite">
            {typingNames.length === 1
              ? `${typingNames[0]} is typing…`
              : `${typingNames.slice(0, -1).join(', ')} and ${typingNames.at(-1)} are typing…`}
          </p>
        {/if}
        <div class="composer-shell transition focus-within:border-primary">
          <div class="composer-toolbar" role="toolbar" aria-label="Message formatting">
            <button type="button" aria-label="Bold" title="Bold (Ctrl+B)" onmousedown={(event) => event.preventDefault()} onclick={() => formatComposer('bold')}><strong>B</strong></button>
            <button type="button" aria-label="Italic" title="Italic (Ctrl+I)" onmousedown={(event) => event.preventDefault()} onclick={() => formatComposer('italic')}><em>I</em></button>
            <button type="button" aria-label="Strikethrough" title="Strikethrough (Ctrl+Shift+X)" onmousedown={(event) => event.preventDefault()} onclick={() => formatComposer('strike')}><span class="line-through">S</span></button>
            <span class="composer-toolbar__divider" aria-hidden="true"></span>
            <button type="button" aria-label="Link" title="Link" onmousedown={(event) => event.preventDefault()} onclick={() => formatComposer('link')}>↗</button>
            <button type="button" aria-label="Inline code" title="Inline code" onmousedown={(event) => event.preventDefault()} onclick={() => formatComposer('code')}>&lt;/&gt;</button>
            <button type="button" aria-label="Block quote" title="Block quote" onmousedown={(event) => event.preventDefault()} onclick={() => formatComposer('quote')}>❯</button>
            <button type="button" aria-label="Bulleted list" title="Bulleted list" onmousedown={(event) => event.preventDefault()} onclick={() => formatComposer('list')}>•≡</button>
            <button type="button" aria-label="Code block" title="Code block" onmousedown={(event) => event.preventDefault()} onclick={() => formatComposer('codeBlock')}>{'{ }'}</button>
            <span class="composer-toolbar__divider" aria-hidden="true"></span>
            <button
              type="button"
              class:composer-toolbar__button--active={showMarkdownMarkers}
              aria-label={showMarkdownMarkers ? 'Hide Markdown markers' : 'Show Markdown markers'}
              aria-pressed={showMarkdownMarkers}
              title={showMarkdownMarkers ? 'Hide Markdown markers' : 'Show Markdown markers'}
              onmousedown={(event) => event.preventDefault()}
              onclick={() => showMarkdownMarkers = !showMarkdownMarkers}
            >M↓</button>
          </div>
          <div class="flex items-end gap-2 p-1.5">
            <div class="composer-field min-w-0 flex-1">
              <div
                bind:this={composer}
                class:markdown-markers-visible={showMarkdownMarkers}
                class="composer-editor"
                contenteditable="true"
                role="textbox"
                tabindex="0"
                aria-multiline="true"
                aria-label={`Message #${data.sharedChannel.channel.name}`}
                aria-autocomplete="list"
                aria-controls="mention-suggestions"
                data-placeholder={replyToId ? 'Write a direct reply' : `Message #${data.sharedChannel.channel.name}`}
                oninput={handleComposerInput}
                onkeyup={(event) => {
                  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateMentionContext();
                }}
                onclick={() => updateMentionContext()}
                onkeydown={handleComposerKeydown}
                onpaste={handleComposerPaste}
              ></div>
              <span class="sr-only" aria-live="polite">
                {mentionMenuOpen ? `${mentionMatches.length} mention ${mentionMatches.length === 1 ? 'suggestion' : 'suggestions'} available.` : ''}
              </span>
              {#if mentionMenuOpen}
                <div id="mention-suggestions" class="mention-suggestions" role="listbox" aria-label="Mention a member">
                  <div class="eyebrow border-b border-white/10 px-3 py-2">Mention</div>
                  {#each mentionMatches as member, index (member.id)}
                    <button
                      id={`mention-option-${member.id}`}
                      class:mention-suggestion--active={index === activeMentionIndex}
                      class="mention-suggestion"
                      type="button"
                      role="option"
                      aria-selected={index === activeMentionIndex}
                      onmousedown={(event) => event.preventDefault()}
                      onclick={() => selectMention(member.name)}
                    >
                      <span class:agent-avatar={member.kind === 'agent'} class="member-avatar member-avatar-small">{initials(member.name)}</span>
                      <span class="min-w-0">
                        <strong class="block truncate text-sm">{member.name}</strong>
                        <span class="block truncate text-[0.68rem] text-base-content/42">{member.roleLabel}</span>
                      </span>
                      <span class="ml-auto text-xs text-primary">@{member.name}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
            <button class="btn btn-primary btn-sm px-5" type="submit" disabled={!messageBody.trim()}>Send <span aria-hidden="true">→</span></button>
          </div>
        </div>
        {#if form?.message}<p class="mt-2 text-sm text-error" role="alert">{form.message}</p>{/if}
      </form>
    </div>
  </section>
</main>

<div id="account-menu" class="account-menu" popover="auto" aria-label="Account menu">
  <div class="border-b border-white/10 px-3 py-3">
    <div class="truncate text-sm font-medium text-[#f1efe8]">{data.currentUser.name}</div>
    <div class="mt-0.5 truncate text-xs text-base-content/38">{data.currentUser.email}</div>
  </div>
  <div class="p-1.5">
    <button
      class="account-menu__item"
      type="button"
      onclick={() => {
        document.getElementById('account-menu')?.hidePopover();
        settingsDialog?.showModal();
      }}
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5" aria-hidden="true">
        <path d="M3 5h5m4 0h5M8 3v4M3 10h9m4 0h1m-5-2v4M3 15h2m4 0h8M5 13v4" />
      </svg>
      Settings
    </button>
    <button class="account-menu__item account-menu__item--danger" type="button" onclick={() => void signOut()}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" aria-hidden="true">
        <path d="M8 4H4v12h4m4-3 3-3-3-3m3 3H8" />
      </svg>
      Sign out
    </button>
  </div>
</div>

<dialog bind:this={settingsDialog} class="settings-dialog" aria-labelledby="settings-title">
  <div class="settings-dialog__header">
    <div>
      <div class="eyebrow">Workspace configuration</div>
      <h2 id="settings-title" class="font-display mt-2 text-2xl font-medium tracking-[-0.04em] text-[#f1efe8]">Settings</h2>
    </div>
    <button class="btn btn-ghost btn-sm px-0 text-base-content/50 hover:bg-transparent hover:text-white" type="button" onclick={() => settingsDialog?.close()} aria-label="Close settings">Close ×</button>
  </div>

  <div class="settings-dialog__body">
    <section class="settings-section" aria-label="Codex Provider connection">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="eyebrow">01 / Provider</div>
          <h3 class="mt-2 text-base font-medium text-[#f1efe8]">Codex</h3>
        </div>
        <span class:badge-success={data.providerConnection.readyForExecution} class="badge badge-sm rounded-sm border-white/12 bg-transparent text-[0.58rem] uppercase tracking-wide">
          {data.providerConnection.state.replace('_', ' ')}
        </span>
      </div>
      <p class="mt-4 max-w-md text-sm leading-6 text-base-content/48">
        {data.providerConnection.readyForExecution
          ? 'Managed ChatGPT login is ready for shared Agent work.'
          : 'New Agent execution is unavailable.'}
      </p>
      {#if data.providerConnection.canManage}
        <div class="mt-5 flex flex-wrap gap-2">
          {#if data.providerConnection.state !== 'disconnecting'}
            <button class="btn btn-primary btn-sm" type="button" disabled={providerBusy} onclick={() => void manageProvider('connect')}>
              {data.providerConnection.state === 'not_connected' ? 'Connect' : 'Replace connection'}
            </button>
          {/if}
          {#if data.providerConnection.state === 'ready' || data.providerConnection.state === 'connecting'}
            <button class="btn btn-ghost btn-sm" type="button" disabled={providerBusy} onclick={() => void manageProvider('disable')}>Disable</button>
          {/if}
          {#if data.providerConnection.state !== 'not_connected'}
            <button class="btn btn-ghost btn-sm text-error" type="button" disabled={providerBusy} onclick={() => void manageProvider('disconnect')}>
              {data.providerConnection.state === 'disconnecting' ? 'Retry disconnect' : 'Disconnect'}
            </button>
          {/if}
        </div>
        {#if managedLogin}
          <div class="mt-5 border-l-2 border-primary pl-4 text-sm">
            <p class="text-base-content/55">Open the managed Codex sign-in page and enter:</p>
            <code class="mt-2 block font-bold tracking-wider text-[#f1efe8]">{managedLogin.userCode}</code>
            <a class="link link-primary mt-2 inline-block" href={managedLogin.verificationUrl} target="_blank" rel="noreferrer">Continue with ChatGPT →</a>
          </div>
        {/if}
        {#if providerMessage}<p class="mt-3 text-sm text-error" role="alert">{providerMessage}</p>{/if}
      {/if}
    </section>

    <section class="settings-section" aria-label="Linked pilot repository">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="eyebrow">02 / Repository</div>
          <h3 class="mt-2 text-base font-medium text-[#f1efe8]">GitHub</h3>
        </div>
        <span class:badge-success={data.linkedRepository.readyForAutonomousWork} class="badge badge-sm rounded-sm border-white/12 bg-transparent text-[0.58rem] uppercase tracking-wide">
          {data.linkedRepository.githubConnectionState.replace('_', ' ')}
        </span>
      </div>
      <p class="mt-4 max-w-md text-sm leading-6 text-base-content/48">
        {data.linkedRepository.readyForAutonomousWork
          ? 'Human-reviewed branch controls are verified.'
          : 'Autonomous repository work is unavailable.'}
      </p>
      {#if githubConfiguration}
        <p class="mt-4 break-all text-sm font-medium text-[#f1efe8]">
          {githubConfiguration.repository.owner}/{githubConfiguration.repository.name}
        </p>
        {#if githubConfiguration.protection.failures.length > 0}
          <ul class="mt-3 list-disc pl-4 text-sm text-error">
            {#each githubConfiguration.protection.failures as failure}
              <li>{failure}</li>
            {/each}
          </ul>
        {/if}
        {#each githubConfiguration.protection.branches.filter((branch) => !branch.protected) as branch}
          <div class="mt-3 text-sm text-error"><strong>{branch.name}</strong>: {branch.failures.join('; ')}</div>
        {/each}
      {/if}
      {#if data.linkedRepository.canManage}
        <div class="mt-5 space-y-3">
          <input class="input input-sm w-full" bind:value={githubInstallationId} inputmode="numeric" placeholder="Installation ID" aria-label="GitHub App installation ID" />
          <input class="input input-sm w-full" bind:value={githubReleaseBranches} placeholder="Release branches, comma separated" aria-label="Release branches" />
          <label class="flex items-start gap-3 text-xs leading-5 text-base-content/60">
            <input class="checkbox checkbox-xs mt-1" type="checkbox" bind:checked={githubNoBypassConfirmed} />
            <span>I confirmed in the current GitHub ruleset that the Relay App is not a bypass actor.</span>
          </label>
          <div class="flex flex-wrap gap-2 pt-1">
            <button class="btn btn-primary btn-sm" type="button" disabled={githubBusy || !githubInstallationId.trim() || !githubNoBypassConfirmed} onclick={() => void manageGitHub('link')}>
              {data.linkedRepository.linkState === 'not_linked' ? 'Link repository' : 'Replace repository'}
            </button>
            {#if data.linkedRepository.linkState === 'linked'}
              <button class="btn btn-ghost btn-sm" type="button" disabled={githubBusy} onclick={() => void manageGitHub('verify')}>Verify controls</button>
            {/if}
            {#if data.linkedRepository.githubConnectionState === 'active'}
              <button class="btn btn-ghost btn-sm" type="button" disabled={githubBusy} onclick={() => void manageGitHub('disable')}>Disable</button>
            {/if}
          </div>
        </div>
        {#if githubMessage}<p class="mt-3 text-sm text-error" role="alert">{githubMessage}</p>{/if}
      {/if}
    </section>

    <section class="settings-section" aria-label="Workspace people">
      <div class="eyebrow">03 / People</div>
      <h3 class="mt-2 text-base font-medium text-[#f1efe8]">Invite teammates</h3>
      <p class="mt-4 text-sm leading-6 text-base-content/48">
        Invite any number of people. Each person receives their own attributable Workspace membership.
      </p>
      {#if data.role === 'owner'}
        <div class="mt-5 flex gap-2">
          <input class="input input-sm min-w-0 flex-1" type="email" bind:value={invitationEmail} placeholder="teammate@example.com" aria-label="Invitation email" />
          <button class="btn btn-primary btn-sm" type="button" disabled={invitationBusy || !invitationEmail.trim()} onclick={() => void inviteMember()}>Invite</button>
        </div>
        {#if invitationMessage}<p class="mt-3 text-xs text-base-content/60" role="status">{invitationMessage}</p>{/if}
        {#if invitationPath}
          <div class="mt-3 border border-white/10 p-3">
            <div class="eyebrow">Invitation link</div>
            <code class="mt-2 block break-all text-xs text-primary">{invitationPath}</code>
            <button class="btn btn-ghost btn-xs mt-2" type="button" onclick={() => void navigator.clipboard.writeText(`${window.location.origin}${invitationPath}`)}>Copy link</button>
          </div>
        {/if}
      {:else}
        <p class="mt-4 text-sm text-base-content/45">Workspace owners can invite teammates.</p>
      {/if}
    </section>

    <section class="settings-section" aria-label="Workspace Agents">
      <div class="eyebrow">04 / Agents</div>
      <h3 class="mt-2 text-base font-medium text-[#f1efe8]">Specialist teammates</h3>
      <p class="mt-3 text-sm leading-6 text-base-content/48">
        A specialist answering you may hand one concrete question to one other Agent. Engineering work still requires a Pilot member to delegate it.
      </p>
      <div class="mt-4 space-y-2">
        {#each data.agentConfiguration.agents as agent (agent.id)}
          <button class="flex w-full items-center gap-3 border border-white/10 p-3 text-left hover:border-primary/60" type="button" onclick={() => editAgent(agent)}>
            <span class="member-avatar member-avatar-small agent-avatar">{initials(agent.name)}</span>
            <span class="min-w-0 flex-1">
              <strong class="block truncate text-sm">{agent.name}</strong>
              <span class="block truncate text-xs text-base-content/45">{agent.roleLabel} · {agent.participationMode}</span>
            </span>
            <span class="text-xs text-primary">Edit</span>
          </button>
        {/each}
      </div>
      {#if data.agentConfiguration.canManage}
        <div class="mt-5 space-y-3 border-t border-white/10 pt-5">
          <div class="space-y-2 border border-white/10 p-3">
            <label class="text-xs text-base-content/60" for="agent-template">Optional bounded template</label>
            <select id="agent-template" class="select select-sm w-full border-white/18 bg-transparent" bind:value={agentTemplateKey}>
              <option value="">Choose a specialist template</option>
              {#each data.agentTemplates as template (template.key)}
                <option value={template.key}>{template.name} · v{template.version}</option>
              {/each}
            </select>
            {#if selectedAgentTemplate}
              <div class="text-xs leading-5 text-base-content/55">
                <strong class="text-[#f1efe8]">{selectedAgentTemplate.roleLabel}</strong>
                <p>{selectedAgentTemplate.instructions}</p>
                <p>Permission ceiling: {selectedAgentTemplate.permissionCeiling.replaceAll('_', ' ')}.</p>
                <p>Does not own: {selectedAgentTemplate.nonResponsibilities.join(', ')}.</p>
                {#if selectedTemplateOverlap}<p class="text-warning">Ambient topic “{selectedTemplateOverlap}” overlaps an existing Agent.</p>{/if}
              </div>
              <button class="btn btn-outline btn-primary btn-sm" type="button" disabled={agentBusy} onclick={() => void instantiateTemplate()}>
                Add from template
              </button>
            {/if}
          </div>
          <div class="flex items-center justify-between gap-2">
            <strong class="text-sm">{editingAgentId ? 'Edit Agent' : 'Add an Agent'}</strong>
            {#if editingAgentId}<button class="btn btn-ghost btn-xs" type="button" onclick={resetAgentForm}>New instead</button>{/if}
          </div>
          <div class="grid grid-cols-2 gap-2">
            <input class="input input-sm" bind:value={agentName} placeholder="Name" aria-label="Agent name" />
            <select class="select select-sm border-white/18 bg-transparent" bind:value={agentType} aria-label="Agent type">
              <option value="engineering">Engineering</option>
              <option value="research">Research</option>
              <option value="product">Product</option>
              <option value="support">Support</option>
              <option value="general">General</option>
            </select>
          </div>
          <input class="input input-sm w-full" bind:value={agentRole} placeholder="Role, e.g. Product researcher" aria-label="Agent role" />
          <textarea class="textarea textarea-sm w-full" rows="3" maxlength="4000" bind:value={agentInstructions} placeholder="Standing instructions and personality" aria-label="Agent instructions"></textarea>
          <input class="input input-sm w-full" bind:value={agentTopics} placeholder="Ambient topics, comma separated" aria-label="Ambient topics" />
          <div class="grid grid-cols-2 gap-2">
            <select class="select select-sm border-white/18 bg-transparent" bind:value={agentParticipation} aria-label="Participation mode">
              <option value="ambient">May join relevant chat</option>
              <option value="reactive">Only when addressed</option>
            </select>
            <select class="select select-sm border-white/18 bg-transparent" bind:value={agentReplyMode} aria-label="Reply placement">
              <option value="adaptive">Adaptive replies</option>
              <option value="channel">Prefer channel</option>
              <option value="thread">Prefer threads</option>
            </select>
          </div>
          <label class="flex items-center gap-2 text-xs text-base-content/60">
            <input class="checkbox checkbox-xs" type="checkbox" bind:checked={agentEnabled} /> Enabled
          </label>
          <button class="btn btn-primary btn-sm" type="button" disabled={agentBusy || !agentName.trim() || !agentRole.trim()} onclick={() => void saveAgent()}>{editingAgentId ? 'Save Agent' : 'Add Agent'}</button>
          {#if agentMessage}<p class="text-xs text-base-content/60" role="status">{agentMessage}</p>{/if}
        </div>
      {/if}
    </section>

    <section class="settings-section" aria-label="Workspaces">
      <div class="eyebrow">05 / Workspaces</div>
      <h3 class="mt-2 text-base font-medium text-[#f1efe8]">Your Workspaces</h3>
      <p class="mt-4 text-sm leading-6 text-base-content/48">
        Each Workspace is an independent boundary for people, Agents, Channels, integrations, and history.
      </p>
      <div class="mt-4 space-y-2">
        {#each data.workspaces as workspace (workspace.id)}
          <div class="flex items-center gap-2 border border-white/10 p-2 text-sm">
            {#if editingWorkspaceId === workspace.id}
              <input
                class="input input-sm min-w-0 flex-1"
                bind:value={editingWorkspaceName}
                maxlength="120"
                aria-label={`New name for ${workspace.name}`}
                onkeydown={(event) => {
                  if (event.key === 'Enter' && editingWorkspaceName.trim()) void saveWorkspaceName(workspace.id);
                  if (event.key === 'Escape') cancelWorkspaceRename();
                }}
              />
              <button class="btn btn-primary btn-xs" type="button" disabled={workspaceBusy || !editingWorkspaceName.trim()} onclick={() => void saveWorkspaceName(workspace.id)}>Save</button>
              <button class="btn btn-ghost btn-xs" type="button" disabled={workspaceBusy} onclick={cancelWorkspaceRename}>Cancel</button>
            {:else}
              <button
                class="min-w-0 flex-1 p-1 text-left disabled:cursor-default"
                type="button"
                disabled={workspaceBusy || workspace.id === data.sharedChannel.workspace.id}
                onclick={() => void switchWorkspace(workspace.id)}
              >
                <strong class="block truncate">{workspace.name}</strong>
                <span class="mt-0.5 block text-xs capitalize text-base-content/40">{workspace.role}</span>
              </button>
              <span class="text-xs text-primary">{workspace.id === data.sharedChannel.workspace.id ? 'Current' : 'Open'}</span>
              {#if workspace.role === 'owner'}
                <button
                  class="btn btn-ghost btn-xs px-2 text-base-content/50 hover:text-white"
                  type="button"
                  disabled={workspaceBusy}
                  title={`Rename ${workspace.name}`}
                  aria-label={`Rename ${workspace.name}`}
                  onclick={() => beginWorkspaceRename(workspace)}
                >
                  <svg class="size-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6" aria-hidden="true">
                    <path d="m12.5 4.5 3 3M4 16l1-4 8-8 3 3-8 8-4 1Z" />
                  </svg>
                </button>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
      <div class="mt-5 flex gap-2 border-t border-white/10 pt-5">
        <input class="input input-sm min-w-0 flex-1" bind:value={newWorkspaceName} maxlength="120" placeholder="Workspace name" aria-label="New Workspace name" />
        <button class="btn btn-primary btn-sm" type="button" disabled={workspaceBusy || !newWorkspaceName.trim()} onclick={() => void addWorkspace()}>Create</button>
      </div>
      {#if workspaceMessage}<p class="mt-3 text-xs text-error" role="alert">{workspaceMessage}</p>{/if}
      {#if workspaceNotice}<p class="mt-3 text-xs text-success" role="status">{workspaceNotice}</p>{/if}
    </section>
  </div>
</dialog>

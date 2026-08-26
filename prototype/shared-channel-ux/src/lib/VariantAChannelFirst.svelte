<script lang="ts">
  import type { JourneyScene, Message, Viewer } from './types';
  import MessageList from './MessageList.svelte';
  import ScenarioControls from './ScenarioControls.svelte';

  let { scene, messages, viewer, step, total, onNext, onReset } = $props<{
    scene: JourneyScene;
    messages: Message[];
    viewer: Viewer;
    step: number;
    total: number;
    onNext: () => void;
    onReset: () => void;
  }>();

  let draft = $state('');
  let sentMessages = $state<Message[]>([]);
  let channelMessages = $derived<Message[]>([...messages, ...sentMessages]);

  let agentDot = $derived(scene.statusTone === 'warning' ? 'bg-warning' : scene.statusTone === 'success' ? 'bg-success' : 'bg-info');

  function sendMessage() {
    const text = draft.trim();
    if (!text) return;

    sentMessages = [
      ...sentMessages,
      { author: viewer, role: 'Pilot member', time: 'now', text }
    ];

    const normalised = text.toLowerCase();
    if (normalised.includes('@alex') && ['progress', 'status', 'going'].some((word) => normalised.includes(word))) {
      sentMessages = [
        ...sentMessages,
        {
          author: 'Alex',
          role: 'Engineering agent',
          time: 'now',
          text: `${scene.status} — ${scene.summary}`,
          accent: true
        }
      ];
    }
    draft = '';
  }

  function resetJourney() {
    sentMessages = [];
    draft = '';
    onReset();
  }
</script>

<main class="mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl grid-cols-[16rem_minmax(0,1fr)] border-x border-base-300 bg-base-100">
  <aside class="hidden border-r border-base-300 bg-base-200/70 p-4 md:block">
    <div class="mb-6 text-lg font-black">Relay</div>
    <div class="text-xs font-bold uppercase tracking-wider text-base-content/45">Project</div>
    <div class="mt-2 rounded-box bg-primary/10 p-3 text-sm font-semibold text-primary">◫ Relay MVP</div>
    <div class="mt-6 text-xs font-bold uppercase tracking-wider text-base-content/45">Channels</div>
    <nav class="menu mt-1 w-full p-0 text-sm">
      <button class="active justify-start font-semibold"># agent-work</button>
      <button class="justify-start"># product</button>
      <button class="justify-start"># general</button>
    </nav>

    <div class="mt-8 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-base-content/45"><span>Direct messages</span><span class="text-base">＋</span></div>
    <div class="mt-2 space-y-1">
      <button class="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-base-300/60">
        <span class="relative flex size-8 items-center justify-center rounded-xl bg-secondary font-bold text-secondary-content">JU<span class="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-base-200 bg-success"></span></span>
        <span class="min-w-0"><strong class="block truncate">Jules</strong><span class="text-xs text-base-content/50">Online</span></span>
      </button>
      <button class="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-base-300/60">
        <span class="relative flex size-8 items-center justify-center rounded-xl bg-secondary font-bold text-secondary-content">RA<span class="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-base-200 bg-success"></span></span>
        <span class="min-w-0"><strong class="block truncate">Ravi</strong><span class="text-xs text-base-content/50">Online</span></span>
      </button>
      <div class="group relative">
        <button aria-describedby="alex-status-detail" class="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm outline-none hover:bg-base-300/60 focus:bg-base-300/60">
          <span class="relative flex size-8 items-center justify-center rounded-xl bg-primary font-bold text-primary-content">AX<span class={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-base-200 ${agentDot}`}></span></span>
          <span class="min-w-0 flex-1"><strong class="block truncate">Alex</strong><span class="block truncate text-xs text-base-content/50">{scene.status}</span></span>
          <span class="text-xs text-base-content/35">›</span>
        </button>
        <div id="alex-status-detail" role="tooltip" class="pointer-events-none absolute left-[calc(100%+0.5rem)] top-0 z-30 hidden w-72 rounded-box border border-base-300 bg-base-100 p-4 text-sm shadow-xl group-focus-within:block group-hover:block">
          <div class="flex items-start justify-between gap-3">
            <div><strong class="block">Alex</strong><span class="text-xs text-base-content/55">Engineering agent · Relay MVP</span></div>
            <span class="badge badge-sm badge-outline">{scene.status}</span>
          </div>
          <div class="mt-3 text-xs font-bold uppercase tracking-wider text-base-content/45">Current Task</div>
          <p class="mt-1 font-semibold">Fix flaky reconnect coverage</p>
          <p class="mt-2 text-xs leading-5 text-base-content/65">{scene.activity[0]}</p>
          <div class="mt-3 border-t border-base-300 pt-3 text-xs text-base-content/55">Human and Agent conversations use the same Direct messages list.</div>
        </div>
      </div>
    </div>
  </aside>

  <section class="flex min-w-0 flex-col">
    <header class="border-b border-base-300 px-5 py-4">
      <h1 class="font-bold"># agent-work</h1>
      <p class="text-xs text-base-content/55">Shared channel · Relay MVP · 3 members</p>
    </header>
    <div class="flex-1 space-y-5 overflow-y-auto p-4 pb-28 sm:p-6">
      <MessageList messages={channelMessages} />

      {#if scene.event === 'recovery'}
        <div class="alert alert-warning py-2 text-sm" role="status">
          <span class="loading loading-spinner loading-sm"></span>
          <span><strong>Relay restarted.</strong> Reconnecting this Channel to Alex’s existing work…</span>
        </div>
      {/if}

      {#if scene.event === 'result'}
        <div class="ml-12 flex flex-wrap items-center gap-3 rounded-box border border-base-300 bg-base-100 p-3 shadow-sm">
          <div class="flex size-10 items-center justify-center rounded-lg bg-success font-black text-success-content">PR</div>
          <div class="min-w-0 flex-1">
            <div class="font-bold">Add restart-safe reconnect coverage</div>
            <div class="text-xs text-base-content/55">Pull request #24 · 4 checks passed</div>
          </div>
          <button class="btn btn-success btn-sm">Review PR ↗</button>
        </div>
      {/if}

      <div class="rounded-box border border-base-300 bg-base-100 p-2 shadow-sm focus-within:border-primary">
        <div class="flex items-center gap-2">
          <input
            class="input input-ghost min-w-0 flex-1 focus:outline-none"
            aria-label="Message #agent-work"
            placeholder="Message #agent-work"
            bind:value={draft}
            onkeydown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) sendMessage();
            }}
          />
          <button class="btn btn-primary btn-sm" onclick={sendMessage} disabled={!draft.trim()}>Send</button>
        </div>
      </div>

      <div class="rounded-box border border-dashed border-error/35 bg-error/5 p-3">
        <div class="mb-2 text-[0.65rem] font-black uppercase tracking-[0.18em] text-error">Prototype journey controls — not product UI</div>
        <ScenarioControls {scene} {step} {total} {onNext} onReset={resetJourney} />
      </div>
    </div>
  </section>
</main>

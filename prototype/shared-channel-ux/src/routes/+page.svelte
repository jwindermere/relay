<script lang="ts">
  import MemberBar from '$lib/MemberBar.svelte';
  import VariantAChannelFirst from '$lib/VariantAChannelFirst.svelte';
  import { messagesThrough, scenes } from '$lib/journey';
  import type { Viewer } from '$lib/types';

  // PROTOTYPE — Accepted shared-channel AgentRun journey; retain only as issue evidence.
  let step = $state(0);
  let viewer = $state<Viewer>('Jules');
  let answerer = $state<Viewer>('Ravi');

  let scene = $derived(scenes[step]);
  let messages = $derived(messagesThrough(step, answerer));

  function next() {
    if (step === 2) answerer = viewer;
    step = step === scenes.length - 1 ? 0 : step + 1;
  }

  function reset() {
    step = 0;
    answerer = 'Ravi';
  }
</script>

<svelte:head>
  <title>Relay shared-channel UX prototype</title>
  <meta name="description" content="Throwaway Relay prototype for the primary shared-channel AgentRun journey" />
</svelte:head>

<div class="navbar min-h-16 border-b border-base-300 bg-base-100 px-4 sm:px-6">
  <div class="flex-1">
    <div>
      <div class="text-xs font-black uppercase tracking-[0.18em] text-error">Prototype · throw away</div>
      <div class="text-sm text-base-content/60">Viewing as authenticated pilot member</div>
    </div>
  </div>
  <MemberBar {viewer} onChange={(nextViewer) => (viewer = nextViewer)} />
</div>

<VariantAChannelFirst {scene} {messages} {viewer} {step} total={scenes.length} onNext={next} onReset={reset} />

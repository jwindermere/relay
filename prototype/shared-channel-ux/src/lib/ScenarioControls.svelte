<script lang="ts">
  import type { JourneyScene } from './types';

  let {
    scene,
    step,
    total,
    onNext,
    onReset
  }: {
    scene: JourneyScene;
    step: number;
    total: number;
    onNext: () => void;
    onReset: () => void;
  } = $props();
</script>

<div class="flex flex-wrap items-center justify-between gap-3 border-t border-base-300 pt-4">
  <div class="flex items-center gap-2">
    <span class="text-xs font-bold uppercase tracking-wider text-base-content/50">Journey {step + 1}/{total}</span>
    <progress class="progress progress-primary w-24" value={step + 1} max={total}></progress>
  </div>
  <div class="flex gap-2">
    {#if step > 0}<button class="btn btn-ghost btn-sm" onclick={onReset}>Reset</button>{/if}
    <button class="btn btn-primary btn-sm" onclick={onNext}>{scene.nextLabel} →</button>
  </div>
</div>

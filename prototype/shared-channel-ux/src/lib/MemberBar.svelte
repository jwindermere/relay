<script lang="ts">
  import type { Viewer } from './types';

  let { viewer, onChange }: { viewer: Viewer; onChange: (viewer: Viewer) => void } = $props();
</script>

<div class="join" aria-label="Authenticated pilot view">
  <button class:btn-active={viewer === 'Jules'} class="btn btn-sm join-item" onclick={() => onChange('Jules')}>
    <span class="size-2 rounded-full bg-success"></span> Jules
  </button>
  <button class:btn-active={viewer === 'Ravi'} class="btn btn-sm join-item" onclick={() => onChange('Ravi')}>
    <span class="size-2 rounded-full bg-success"></span> Ravi
  </button>
</div>

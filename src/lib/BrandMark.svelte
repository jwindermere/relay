<script lang="ts">
  let {
    compact = false,
    class: className = ''
  }: {
    compact?: boolean;
    class?: string;
  } = $props();
</script>

<span class={`brand-lockup ${className}`} aria-label="Relay">
  <svg class="brand-symbol" viewBox="0 0 72 56" aria-hidden="true">
    <path d="M39 10H23C14.7 10 8 16.7 8 25s6.7 15 15 15h8" fill="none" stroke="#5f7cff" stroke-linecap="round" stroke-width="8" />
    <circle cx="49" cy="10" r="8" fill="#5f7cff" />
    <path d="M33 46h16c8.3 0 15-6.7 15-15s-6.7-15-15-15h-8" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="8" />
    <circle cx="23" cy="46" r="8" fill="currentColor" />
  </svg>
  {#if !compact}<span class="brand-wordmark">Relay</span>{/if}
</span>

<style>
  .brand-lockup {
    display: inline-flex;
    align-items: center;
    gap: 0.55rem;
    color: #f1efe8;
    line-height: 1;
  }

  .brand-symbol {
    width: 2rem;
    height: auto;
    overflow: visible;
  }

  .brand-wordmark {
    font-family: var(--font-display);
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: -0.04em;
  }
</style>

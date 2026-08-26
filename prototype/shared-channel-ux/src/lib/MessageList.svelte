<script lang="ts">
  import type { Message } from './types';

  let { messages, dense = false }: { messages: Message[]; dense?: boolean } = $props();

  const initials = { Jules: 'JU', Ravi: 'RA', Alex: 'AX' };
</script>

<div class:space-y-2={dense} class:space-y-5={!dense}>
  {#each messages as message}
    <article class="group flex gap-3 rounded-box p-2 transition hover:bg-base-200/60">
      <div class="avatar placeholder shrink-0">
        <div class:bg-primary={message.author === 'Alex'} class:bg-secondary={message.author !== 'Alex'} class="w-9 rounded-xl text-xs font-bold text-white">
          <span>{initials[message.author]}</span>
        </div>
      </div>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-baseline gap-x-2">
          <strong>{message.author}</strong>
          <span class="text-xs text-base-content/50">{message.role} · {message.time}</span>
        </div>
        <p class="mt-1 text-sm leading-6" class:text-primary={message.accent}>{message.text}</p>
      </div>
    </article>
  {/each}
</div>

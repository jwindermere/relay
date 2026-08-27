<script lang="ts">
  import { renderMarkdown } from './markdown.js';

  let { body, mentionNames = [] }: { body: string; mentionNames?: string[] } = $props();
  let html = $derived(renderMarkdown(body, mentionNames));
</script>

<div class="markdown-body">{@html html}</div>

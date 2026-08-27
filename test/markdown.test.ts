import assert from 'node:assert/strict';
import { test } from 'node:test';

import { highlightMarkdownInput, renderMarkdown } from '../src/lib/markdown.js';

test('message Markdown renders formatting and known mentions', () => {
  const rendered = renderMarkdown('Hello **team** and @Alex.\n\n- one\n- two', ['Alex']);

  assert.match(rendered, /<strong>team<\/strong>/);
  assert.match(rendered, /<span class="mention-token">@Alex<\/span>\./);
  assert.match(rendered, /<ul>[\s\S]*<li>one<\/li>[\s\S]*<li>two<\/li>/);
});

test('message Markdown removes unsafe HTML and link protocols', () => {
  const rendered = renderMarkdown('[safe](https://example.com) [unsafe](javascript:alert(1))<script>alert(2)</script>');

  assert.match(rendered, /href="https:\/\/example\.com"/);
  assert.doesNotMatch(rendered, /javascript:|<script|alert\(2\)/);
  assert.match(rendered, /target="_blank"/);
  assert.match(rendered, /rel="noopener noreferrer"/);
});

test('the composer highlights Markdown without changing its text content', () => {
  const input = '**bold** _italic_ `code` @Alex <script>\n```ts\nconst ready = true;\n```';
  const highlighted = highlightMarkdownInput(input, ['Alex']);

  assert.match(highlighted, /<strong>bold<\/strong>/);
  assert.match(highlighted, /<em>italic<\/em>/);
  assert.match(highlighted, /<code>code<\/code>/);
  assert.match(highlighted, /mention-token">@Alex/);
  assert.match(highlighted, /markdown-code-line markdown-code-line--first/);
  assert.match(highlighted, /&lt;script&gt;/);
  assert.equal(highlighted.replace(/<[^>]+>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>'), input);
});

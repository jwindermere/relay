import { marked, Renderer, type Tokens } from 'marked';
import sanitizeHtml from 'sanitize-html';

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function highlightMentions(html: string, mentionNames: readonly string[]): string {
  const names = mentionNames
    .filter(Boolean)
    .map(escapeHtml)
    .sort((left, right) => right.length - left.length);
  if (names.length === 0) return html;
  const pattern = new RegExp(`@(?:${names.map(escapePattern).join('|')})(?=$|\\s|[.,!?;:])`, 'gi');
  return html.replace(pattern, (mention) => `<span class="mention-token">${mention}</span>`);
}

function highlightMarkdownInline(body: string, names: readonly string[]): string {
  const mentionSource = names.length > 0 ? `|@(?:${names.map(escapePattern).join('|')})(?=$|\\s|[.,!?;:])` : '';
  const tokenPattern = new RegExp(
    `\\*\\*([^*\\n]+)\\*\\*|__([^_\\n]+)__|~~([^~\\n]+)~~|\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)|\`([^\`\\n]+)\`|_([^_\\n]+)_|\\*([^*\\n]+)\\*${mentionSource}`,
    'gi'
  );
  let output = '';
  let cursor = 0;
  for (const match of body.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    output += escapeHtml(body.slice(cursor, index));
    const raw = match[0];
    if (raw.startsWith('**') || raw.startsWith('__')) {
      output += `<span class="markdown-syntax">${escapeHtml(raw.slice(0, 2))}</span><strong>${escapeHtml(match[1] ?? match[2])}</strong><span class="markdown-syntax">${escapeHtml(raw.slice(-2))}</span>`;
    } else if (raw.startsWith('~~')) {
      output += `<span class="markdown-syntax">~~</span><del>${escapeHtml(match[3])}</del><span class="markdown-syntax">~~</span>`;
    } else if (raw.startsWith('[')) {
      output += `<span class="markdown-syntax">[</span><span class="markdown-link">${escapeHtml(match[4])}</span><span class="markdown-syntax">](${escapeHtml(match[5])})</span>`;
    } else if (raw.startsWith('`')) {
      output += `<span class="markdown-syntax">\`</span><code>${escapeHtml(match[6])}</code><span class="markdown-syntax">\`</span>`;
    } else if (raw.startsWith('_') || raw.startsWith('*')) {
      output += `<span class="markdown-syntax">${escapeHtml(raw[0])}</span><em>${escapeHtml(match[7] ?? match[8])}</em><span class="markdown-syntax">${escapeHtml(raw.at(-1) ?? '')}</span>`;
    } else {
      output += `<span class="mention-token">${escapeHtml(raw)}</span>`;
    }
    cursor = index + raw.length;
  }
  return output + escapeHtml(body.slice(cursor));
}

export function highlightMarkdownInput(body: string, mentionNames: readonly string[] = []): string {
  const names = mentionNames.filter(Boolean).sort((left, right) => right.length - left.length);
  let fenced = false;
  let fencedLine = 0;
  return body.split('\n').map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      if (fenced) fencedLine = 0;
      return `<span class="markdown-syntax markdown-block-syntax">${escapeHtml(line)}</span>`;
    }
    if (fenced) {
      const firstClass = fencedLine++ === 0 ? ' markdown-code-line--first' : '';
      return `<span class="markdown-code-line${firstClass}">${escapeHtml(line)}</span>`;
    }
    const prefix = line.match(/^(\s*)(#{1,6}|>|[-+*]|\d+\.)\s+/);
    if (!prefix) return highlightMarkdownInline(line, names);
    const markerEnd = prefix[0].length;
    return `${escapeHtml(prefix[1])}<span class="markdown-syntax markdown-block-syntax">${escapeHtml(line.slice(prefix[1].length, markerEnd))}</span>${highlightMarkdownInline(line.slice(markerEnd), names)}`;
  }).join('\n');
}

export function renderMarkdown(body: string, mentionNames: readonly string[] = []): string {
  const renderer = new Renderer();
  const renderText = renderer.text.bind(renderer);
  renderer.text = (token: Tokens.Text | Tokens.Escape) =>
    highlightMentions(String(renderText(token)), mentionNames);

  const rendered = marked.parse(body, {
    async: false,
    breaks: true,
    gfm: true,
    renderer
  });

  return sanitizeHtml(rendered, {
    allowedTags: [
      'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span'
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      code: ['class'],
      span: ['class']
    },
    allowedClasses: {
      code: [/^language-[\w-]+$/],
      span: ['mention-token']
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attributes) => ({
        tagName: 'a',
        attribs: { ...attributes, target: '_blank', rel: 'noopener noreferrer' }
      })
    }
  });
}

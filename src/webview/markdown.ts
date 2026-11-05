import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// "- [ ] task" → a checkbox carrying its index, so a click can flip the right line in the source.
md.core.ruler.after('inline', 'desk_tasks', (state) => {
  const tokens = state.tokens;
  let index = 0;
  for (let i = 2; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const m = /^\[([ xX])\](?:\s+|$)/.exec(tok.content);
    const first = tok.children?.[0];
    if (!m || !first || first.type !== 'text' || !/^\[[ xX]\]/.test(first.content)) continue;
    const checked = m[1] !== ' ';
    first.content = first.content.slice(3).replace(/^\s+/, '');
    const cb = new state.Token('html_inline', '', 0);
    cb.content = `<input type="checkbox" class="task" data-task="${index}"${checked ? ' checked' : ''}>`;
    tok.children!.unshift(cb);
    tokens[i - 2].attrJoin('class', checked ? 'task done' : 'task');
    index++;
  }
});

const FILE_EXT =
  'ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|py|go|rs|java|kt|kts|rb|php|cs|cpp|cc|c|h|hpp|m|swift|dart|scala|css|scss|less|html|vue|svelte|astro|yml|yaml|toml|ini|cfg|conf|env|sh|bash|zsh|sql|prisma|graphql|proto|txt|csv|xml|lock|canvas|ipynb|tf|dockerfile';
const PATH_RE = new RegExp(`^(?:[\\w.@~-]*\\/[\\w.@/-]+|[\\w.@-]+\\.(?:${FILE_EXT}))(?:#L\\d+|:\\d+(?::\\d+)?)?$`, 'i');

const plainCode = md.renderer.rules.code_inline!;
md.renderer.rules.code_inline = (tokens, idx, opts, env, self) => {
  const c = tokens[idx].content;
  if (c.length < 240 && PATH_RE.test(c) && !/^https?:/i.test(c)) {
    const e = md.utils.escapeHtml(c);
    return `<code class="path" data-open="${e}">${e}</code>`;
  }
  return plainCode(tokens, idx, opts, env, self);
};

const cache = new Map<string, string>();

export function renderMarkdown(text: string): string {
  let html = cache.get(text);
  if (html === undefined) {
    html = md.render(text);
    if (cache.size > 800) cache.clear();
    cache.set(text, html);
  }
  return html;
}

/** Flip the index-th "[ ]"/"[x]" task marker, counting the way the renderer does. */
export function toggleTask(text: string, index: number): string {
  const lines = text.split('\n');
  let k = 0;
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const m = /^([\s>]*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](?=\s|$)/.exec(lines[i]);
    if (!m) continue;
    if (k++ === index) {
      lines[i] = m[1] + (m[2] === ' ' ? '[x]' : '[ ]') + lines[i].slice(m[0].length);
      break;
    }
  }
  return lines.join('\n');
}

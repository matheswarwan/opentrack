// Atlassian Document Format (Jira Cloud rich text, API v3) to Markdown.
// Covers paragraphs, headings, bullet/ordered/task lists, code blocks, quotes, panels, rules, tables,
// links, marks (bold, italic, strike, code), mentions (as plain @Name text), emoji, dates, status lozenges,
// smart links and media (as a placeholder naming the file). Unknown nodes render their children.

const text = (v) => (v === undefined || v === null ? '' : String(v));

/** Wrap s in a Markdown mark, keeping surrounding spaces outside it (`** x**` is not bold). */
function wrap(s, open, close = open) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  if (!m[2]) return s;
  return `${m[1]}${open}${m[2]}${close}${m[3]}`;
}

function markText(node) {
  let s = text(node.text);
  const marks = node.marks || [];
  const has = (t) => marks.find((m) => m.type === t);
  if (has('code')) s = '`' + s.replace(/`/g, "'") + '`';
  if (has('strong')) s = wrap(s, '**');
  if (has('em')) s = wrap(s, '*');
  if (has('strike')) s = wrap(s, '~~');
  const link = has('link');
  if (link?.attrs?.href) s = `[${s}](${link.attrs.href})`;
  return s;
}

function mediaName(node) {
  const a = node.attrs || {};
  return a.alt || a.__fileName || a.fileName || a.filename || a.id || 'file';
}

function inline(nodes = []) {
  let out = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out += markText(n);
        break;
      case 'hardBreak':
        out += '  \n';
        break;
      case 'mention': {
        const t = text(n.attrs?.text || n.attrs?.displayName || 'someone');
        out += t.startsWith('@') ? t : `@${t}`;
        break;
      }
      case 'emoji':
        out += text(n.attrs?.text || n.attrs?.shortName);
        break;
      case 'date': {
        const ms = Number(n.attrs?.timestamp);
        out += Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
        break;
      }
      case 'status':
        out += `[${text(n.attrs?.text)}]`;
        break;
      case 'inlineCard':
        out += n.attrs?.url ? `<${n.attrs.url}>` : '';
        break;
      case 'mediaInline':
      case 'media':
        out += `[Attachment: ${mediaName(n)}]`;
        break;
      case 'placeholder':
        break;
      default:
        out += inline(n.content || []);
    }
  }
  return out;
}

function indent(s, pad) {
  return s
    .split('\n')
    .map((l, i) => (i === 0 || !l ? l : pad + l))
    .join('\n');
}

function listItems(node, marker) {
  return (node.content || [])
    .map((item, i) => {
      const m = marker(item, i);
      const body = (item.content || [])
        .map((c) => (c.type === 'paragraph' ? inline(c.content) : block(c)))
        .filter((s) => s !== '')
        .join('\n');
      // taskItem / decisionItem hold inline content directly
      const own = item.content && item.content.every((c) => !isBlock(c)) ? inline(item.content) : body;
      return m + indent(own, ' '.repeat(m.length));
    })
    .join('\n');
}

const BLOCKS = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'decisionList',
  'listItem',
  'taskItem',
  'decisionItem',
  'codeBlock',
  'blockquote',
  'rule',
  'panel',
  'table',
  'mediaSingle',
  'mediaGroup',
  'expand',
  'nestedExpand',
  'blockCard',
  'embedCard',
]);
const isBlock = (n) => BLOCKS.has(n.type);

function cell(c) {
  return (c.content || [])
    .map((x) => (x.type === 'paragraph' ? inline(x.content) : block(x).replace(/\n+/g, ' ')))
    .join(' ')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
    .trim();
}

function block(n) {
  switch (n.type) {
    case 'paragraph':
      return inline(n.content).replace(/[ \t]+$/, '');
    case 'heading': {
      const level = Math.min(Math.max(Number(n.attrs?.level) || 1, 1), 6);
      return `${'#'.repeat(level)} ${inline(n.content)}`;
    }
    case 'bulletList':
      return listItems(n, () => '- ');
    case 'orderedList': {
      const start = Number(n.attrs?.order) || 1;
      return listItems(n, (_, i) => `${start + i}. `);
    }
    case 'taskList':
      return listItems(n, (item) => (item.attrs?.state === 'DONE' ? '- [x] ' : '- [ ] '));
    case 'decisionList':
      return listItems(n, () => '- ');
    case 'codeBlock': {
      const code = (n.content || []).map((t) => text(t.text)).join('');
      const fence = code.includes('```') ? '~~~' : '```';
      return `${fence}${text(n.attrs?.language)}\n${code}\n${fence}`;
    }
    case 'blockquote':
    case 'panel':
      return blocks(n.content)
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'rule':
      return '---';
    case 'mediaSingle':
    case 'mediaGroup':
      return (n.content || []).map((m) => `[Attachment: ${mediaName(m)}]`).join('\n');
    case 'blockCard':
    case 'embedCard':
      return n.attrs?.url ? `<${n.attrs.url}>` : '';
    case 'expand':
    case 'nestedExpand': {
      const title = text(n.attrs?.title);
      return [title ? `**${title}**` : '', blocks(n.content)].filter(Boolean).join('\n\n');
    }
    case 'table': {
      const rows = (n.content || []).map((r) => (r.content || []).map(cell));
      if (!rows.length) return '';
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
      return [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
    }
    default:
      if (n.content) return n.content.some(isBlock) ? blocks(n.content) : inline(n.content);
      return inline([n]);
  }
}

function blocks(nodes = []) {
  return nodes
    .map(block)
    .filter((s) => s !== '')
    .join('\n\n');
}

/** Convert an ADF document (or a plain string, as API v2 returns) to Markdown. */
export function adfToMarkdown(doc) {
  if (doc === null || doc === undefined) return '';
  if (typeof doc === 'string') return doc;
  if (Array.isArray(doc)) return blocks(doc).trim();
  if (doc.type === 'doc') return blocks(doc.content).trim();
  return block(doc).trim();
}

import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Markdown to safe HTML. Mentions @[Name](user:id) become chips; issue keys become links. */
export function renderMarkdown(text) {
  if (!text) return '';
  const withMentions = text.replace(
    /@\[([^\]]{1,100})\]\(user:[0-9a-f-]{36}\)/g,
    (_, name) => `<span class="mention">@${esc(name)}</span>`,
  );
  const html = marked.parse(withMentions);
  const linked = html.replace(/(^|[\s(>])([A-Z][A-Z0-9]{1,9}-\d+)(?=$|[\s).,:;<])/g, '$1<a href="/browse/$2">$2</a>');
  return DOMPurify.sanitize(linked, { ADD_ATTR: ['target'] });
}

/** Plain text preview (mentions as @Name). */
export function plain(text) {
  return String(text || '').replace(/@\[([^\]]{1,100})\]\(user:[0-9a-f-]{36}\)/g, '@$1');
}

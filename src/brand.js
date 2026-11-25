// Workspace fonts: applies the stacks and uploaded font files from /api/auth/config `fonts`.
// '' / null keeps the default stacks from style.css (Geist).
const FORMATS = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };

/** Presets for Admin > Settings > Fonts. */
export const FONT_PRESETS = [
  { id: 'default', label: 'Default (Geist)', heading: '', body: '' },
  {
    id: 'system',
    label: 'System (the operating system font)',
    heading: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    body: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  },
];

const cssString = (s) => `"${String(s).replace(/["\\\n]/g, '')}"`;

/** The @font-face rules for the uploaded files. */
export function fontFaceCss(faces = []) {
  return faces
    .map(
      (f) =>
        `@font-face{font-family:${cssString(f.family)};src:url(${cssString(f.url)}) format(${cssString(FORMATS[f.format] || f.format)});font-weight:${Number(f.weight) || 400};font-style:${f.style === 'italic' ? 'italic' : 'normal'};font-display:swap}`,
    )
    .join('\n');
}

export function applyFonts(fonts) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement.style;
  if (fonts?.body) root.setProperty('--font-sans', fonts.body);
  else root.removeProperty('--font-sans');
  if (fonts?.heading) root.setProperty('--font-display', fonts.heading);
  else root.removeProperty('--font-display');
  let el = document.getElementById('workspace-fonts');
  const css = fontFaceCss(fonts?.faces);
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = 'workspace-fonts';
    document.head.appendChild(el);
  }
  el.textContent = css;
}

/** At startup: the public config (works before sign-in). Failures keep the default fonts. */
export async function loadFonts() {
  try {
    const r = await fetch('/api/auth/config', { headers: { accept: 'application/json' } });
    if (r.ok) applyFonts((await r.json()).fonts);
  } catch {
    /* default fonts */
  }
}

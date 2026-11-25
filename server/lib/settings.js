// Workspace settings kept in the `settings` table (admin editable).
export const DEFAULT_SETTINGS = {
  appName: 'Opentrack',
  // who may create projects: 'everyone' (members and admins) or 'admins'
  projectCreation: 'everyone',
  // Google sign-in: comma separated domains allowed (empty = any verified Google account that is provisioned)
  googleDomains: '',
  // create a member account on first Google sign-in for an allowed domain (otherwise admins provision users first)
  googleAutoProvision: false,
  // allow password sign-in (turn off once everyone uses Google)
  passwordLogin: true,
  // personal API tokens and the MCP server (/mcp) for AI assistants
  apiTokens: true,
  // days to keep the MCP audit log (AI assistant calls)
  mcpLogDays: 90,
  // secret CSV feed URLs for Google Sheets (IMPORTDATA); off stops every feed at once
  sheetFeeds: true,
  // IANA time zone for scheduled jobs (due-date reminders at 08:00, the weekly digest)
  timeZone: 'America/Vancouver',
  // days a deleted issue stays in the Trash before the daily job removes it for good
  trashDays: 30,
  // channel AI sessions (server/lib/channelAi.js): project admins may turn on AI summaries of linked Slack channels
  channelAi: false,
  // also on external channels (shared with clients): client messages are then sent to the AI provider
  channelAiExternal: false,
  // capacity planning: weekly hours of anyone who has not set their own (hours per weekday = weekly / 5)
  defaultCapacityHours: 40,
  // fonts: CSS font stacks for headings (h1, h2) and everything else; '' = the default fonts (Geist). A family only shows if it is installed on the viewer's
  // machine or uploaded under Admin > Settings > Fonts (server/routes/fonts.js).
  fontHeading: '',
  fontBody: '',
  // security (migration 0033): email domains new accounts may use ([] = any). Checked when an admin adds, invites or
  // imports a user and when Google sign-in would create an account. Existing users outside the list keep working.
  allowedDomains: [],
  // sessions not used for this many minutes are signed out (0 = off, else 15 to 10080)
  idleTimeoutMinutes: 0,
  // admins must turn on two-factor sign-in before they can do anything else (admins with a password; see lib/twofactor.js)
  require2faAdmins: false,
};

/** A CSS font stack: family names (quoted or not) separated by commas, nothing that could end the declaration. */
export const FONT_STACK = /^[A-Za-z0-9 ,"'._-]{0,300}$/;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Clean a list of email domains (array, or text split on commas, spaces and new lines); throws a plain Error on a bad one. */
export function cleanDomains(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/);
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw new Error('allowedDomains must be a list of domains');
    const d = raw.trim().toLowerCase().replace(/^@/, '');
    if (!d) continue;
    if (d.length > 100 || !DOMAIN_RE.test(d))
      throw new Error(`${raw.trim().slice(0, 100)} is not a domain (use the part after the @, such as acme.com)`);
    if (!out.includes(d)) out.push(d);
  }
  if (out.length > 50) throw new Error('At most 50 allowed domains');
  return out;
}

/** True when the email may get a new account (no list = any domain). */
export function domainAllowed(settings, email) {
  const list = Array.isArray(settings.allowedDomains) ? settings.allowedDomains : [];
  if (!list.length) return true;
  return list.includes(
    String(email || '')
      .toLowerCase()
      .split('@')
      .pop(),
  );
}

/** The plain message for an email outside the list. */
export function domainMessage(settings, email) {
  const list = settings.allowedDomains || [];
  return `${email} is not in an allowed email domain (${list.join(', ')}). An admin can change the list under Admin > Settings.`;
}

export async function getSettings(db) {
  const rows = await db.all('SELECT key, value FROM settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (!(r.key in DEFAULT_SETTINGS)) continue;
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      /* keep default */
    }
  }
  return out;
}

export function settingStatements(patch) {
  const stmts = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmts.push({ sql: 'DELETE FROM settings WHERE key = ?', params: [k] });
    stmts.push({ sql: 'INSERT INTO settings (key, value) VALUES (?, ?)', params: [k, JSON.stringify(v)] });
  }
  return stmts;
}

// Chrome's built-in AI (Prompt API, Gemini Nano). Runs on the person's device; nothing is sent to a server.
// Available in recent desktop Chrome where the model is supported; otherwise the AI buttons stay hidden.
import { ref } from 'vue';

export const aiState = ref('checking'); // checking | unavailable | downloadable | downloading | available
export const aiProgress = ref(0);

export async function checkAi() {
  try {
    if (!('LanguageModel' in self)) return (aiState.value = 'unavailable');
    aiState.value = await self.LanguageModel.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
  } catch {
    aiState.value = 'unavailable';
  }
  return aiState.value;
}

async function session(system) {
  return self.LanguageModel.create({
    initialPrompts: [{ role: 'system', content: system }],
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        aiState.value = 'downloading';
        aiProgress.value = Math.round((e.loaded || 0) * 100);
      });
    },
  });
}

const SYSTEM = `You help people at a consulting company write clear tickets for an issue tracker (like Jira).
Rewrite the ticket so a teammate can act on it without asking questions. Keep every fact the person gave; never invent names, numbers, systems, dates or links.
Write plain, direct English. No marketing words, no emoji, no em dashes.
Title: at most 90 characters, starts with a verb for tasks and stories, names the problem for bugs.
Description in Markdown with short sections that fit the type:
- bug: "## What happens", "## Expected", "## Steps to reproduce" (numbered; write "Not given" when unknown), "## Notes"
- story: "## Goal" (As a ..., I want ..., so that ...), "## Acceptance criteria" (checklist "- [ ] ...")
- task: "## What to do", "## Done when" (checklist)
- epic: "## Outcome", "## Scope", "## Out of scope"
Suggest the type, a priority (highest, high, medium, low, lowest; medium unless the text shows urgency) and up to 3 short lowercase labels.`;

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    type: { type: 'string', enum: ['epic', 'story', 'task', 'bug', 'subtask'] },
    priority: { type: 'string', enum: ['highest', 'high', 'medium', 'low', 'lowest'] },
    labels: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['title', 'description', 'type', 'priority', 'labels'],
};

const mask = (t) =>
  String(t || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(?:sk|xox[abp]|atk|atr|ghp)[-_][\w-]{10,}\b/g, '[secret]')
    .slice(0, 8000);

/** Improve a draft ticket. Returns { title, description, type, priority, labels }. */
export async function enhanceTicket({ title, description, type, projectName }) {
  const s = await session(SYSTEM);
  try {
    const prompt = `Project: ${projectName || 'unknown'}\nCurrent type: ${type || 'task'}\nTitle: ${mask(title)}\nDescription:\n${mask(description) || '(empty)'}`;
    const out = await s.prompt(prompt, { responseConstraint: SCHEMA });
    const r = JSON.parse(out);
    return {
      title: String(r.title || title).slice(0, 255),
      description: String(r.description || ''),
      type: r.type,
      priority: r.priority,
      labels: Array.isArray(r.labels) ? r.labels.map((l) => String(l).toLowerCase().replace(/\s+/g, '-')).slice(0, 3) : [],
    };
  } finally {
    s.destroy?.();
  }
}

/** Summarise an issue's comments into a short status update. */
export async function summariseIssue({ key, title, status, description, comments }) {
  const s = await session(
    'You write short status summaries of tickets for busy teammates. Plain English, no emoji, no em dashes, at most 5 bullet points, then one line "Next:" with the next step if the text shows one. Never invent facts.',
  );
  try {
    const thread = comments
      .map((c) => `${c.author}: ${mask(c.body)}`)
      .join('\n')
      .slice(-6000);
    return await s.prompt(
      `${key} ${mask(title)} (status: ${status})\nDescription:\n${mask(description).slice(0, 2000)}\nComments, oldest first:\n${thread || '(none)'}`,
    );
  } finally {
    s.destroy?.();
  }
}

// The running issue timer (server: /api/me/timer). The timer lives on the server, so it survives reloads and shows
// in every tab; this module keeps a copy, refreshes it every minute and ticks the elapsed time once a second.
import { reactive } from 'vue';
import { get, post, del, toast, session } from './api.js';
import { changed } from './ui.js';
import { today, pad, fmtHours } from './dates.js';
import { attempt } from './composables/useAction.js';

export const timerState = reactive({
  timer: null, // { issueKey, title, type, startedAt, ... } or null
  skew: 0, // server clock minus this device's clock (ms), so a wrong local clock does not distort the display
  tick: Date.now(),
  confirmAfterHours: 12,
  stopping: false, // the Stop dialog is open (src/components/TimerStopDialog.vue)
  busy: false,
});

let ticker = null;
let poller = null;

function setTimer(t) {
  timerState.timer = t || null;
  timerState.tick = Date.now();
  if (t && !ticker)
    ticker = setInterval(() => {
      timerState.tick = Date.now();
    }, 1000);
  if (!t && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
  if (!t) timerState.stopping = false;
}

export async function loadTimer() {
  if (!session.user) return;
  try {
    const r = await get('/api/me/timer');
    timerState.skew = Date.parse(r.now) - Date.now();
    timerState.confirmAfterHours = r.confirmAfterHours || 12;
    setTimer(r.timer);
  } catch {
    /* signed out or offline: keep what we have */
  }
}

/** Start refreshing (called once the app shell is shown). */
export function watchTimer() {
  loadTimer();
  if (!poller) poller = setInterval(loadTimer, 60000);
}

/** Milliseconds the timer has run. */
export function elapsedMs() {
  const t = timerState.timer;
  return t ? Math.max(0, timerState.tick + timerState.skew - Date.parse(t.startedAt)) : 0;
}

/** Whole minutes, rounded up (at least one), as the server logs them. */
export const minutesOf = (ms) => Math.max(1, Math.ceil(ms / 60000));

/** 3725000 -> "1:02:05" */
export function clockText(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** 95 -> "1 h 35 min" (for screen readers and messages) */
export function minutesText(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h ? `${h} h` : '', m || !h ? `${m} min` : ''].filter(Boolean).join(' ');
}

export async function startTimer(issueKey) {
  timerState.busy = true;
  try {
    const r = await post('/api/me/timer/start', { issueKey });
    setTimer(r.timer);
    if (r.logged) {
      toast(`Timer started on ${issueKey}. Logged ${minutesText(r.logged.minutes)} on ${r.logged.issueKey}.`);
      changed();
    } else toast(`Timer started on ${issueKey}`);
  } catch (e) {
    toast(e.message, 'error');
    if (e.data?.code === 'timer_running') await loadTimer();
  } finally {
    timerState.busy = false;
  }
}

/** Ask for the note (and the hours of a long timer), then stop. */
export function askStop() {
  if (timerState.timer) timerState.stopping = true;
}

/** opts: { note, billable, hours? }. Returns true when the time was logged. */
export async function stopTimer(opts = {}) {
  timerState.busy = true;
  try {
    const workDate = today();
    const r = await post('/api/me/timer/stop', { ...opts, workDate });
    setTimer(null);
    toast(`Logged ${r.logged.hours === undefined ? '' : `${fmtHours(r.logged.hours)}h `}on ${r.logged.issueKey}`);
    changed(); // open issue pages and lists reload
    return true;
  } catch (e) {
    if (e.status === 404 && /No timer/.test(e.message)) setTimer(null); // stopped in another tab
    toast(e.message, 'error');
    return false;
  } finally {
    timerState.busy = false;
  }
}

export async function discardTimer() {
  const t = timerState.timer;
  if (!t) return;
  if (!confirm(`Discard the timer on ${t.issueKey}? The ${minutesText(minutesOf(elapsedMs()))} will not be logged.`)) return;
  await attempt(async () => {
    await del('/api/me/timer');
    setTimer(null);
    toast('Timer discarded');
  });
}

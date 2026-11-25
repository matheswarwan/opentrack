<script setup>
// Help: Webhooks
</script>
<template>
  <p>
    A webhook sends a JSON message to another system (a deploy bot, a reporting tool, an automation service) when something happens. Project
    admins add them under Project settings &gt; Webhooks for one project; admins add workspace-wide ones under
    <RouterLink to="/admin/webhooks" class="link">Admin &gt; Webhooks</RouterLink>, which get events from every project.
  </p>
  <ul class="list-disc space-y-1 pl-5">
    <li>
      <strong>Events</strong>: <code>issue.created</code>, <code>issue.updated</code> (with the changed fields in <code>changes</code>),
      <code>issue.deleted</code> (to the Trash), <code>issue.restored</code>, <code>comment.created</code>, <code>sprint.started</code>,
      <code>sprint.completed</code>, <code>release.released</code>. Internal notes are sent only to webhooks that ask for them.
    </li>
    <li>
      <strong>Body</strong>: <code>event</code>, <code>deliveredAt</code>, <code>workspaceUrl</code>, <code>project</code> (key, name),
      <code>issue</code> (key, title, type, status, priority, assignee, url), <code>actor</code> (who did it), <code>changes</code>,
      <code>comment</code>, and <code>sprint</code> or <code>release</code> for those events.
    </li>
    <li>
      <strong>Headers</strong>: <code>X-Tracker-Event</code>, <code>X-Tracker-Delivery</code> (a unique id, also in the delivery log) and
      <code>X-Tracker-Signature</code>: <code>sha256=</code> followed by the HMAC-SHA256 of the raw body, keyed with the webhook's signing
      secret.
    </li>
    <li>
      <strong>Signing secret</strong>: shown once, when the webhook is added. Only its last 4 characters are shown after that. To get a new
      one, delete the webhook and add it again.
    </li>
    <li>
      <strong>Delivery</strong>: right after the change is saved, with a 10 second limit. Redirects are not followed. Any 2xx answer counts
      as delivered. Each webhook keeps its last 50 deliveries (result, time, size and the first 2 KB of the body); <em>Send test</em> sends
      a <code>ping</code> event and <em>Redeliver</em> sends an event again. After 20 failed deliveries in a row the webhook is turned off
      and the person who added it gets a notification.
    </li>
    <li>
      <strong>Addresses</strong>: https only, and never localhost or a private, loopback or link-local address. Bulk changes of more than 20
      issues send no webhooks.
    </li>
  </ul>
  <p>Check the signature before trusting a message. In Node:</p>
  <pre
    tabindex="0"
    aria-label="Example: checking a webhook signature in Node"
    class="overflow-x-auto rounded-md bg-slate-50 p-3 font-mono text-xs"
  >
// Node: check a tracker webhook before trusting it
import { createHmac, timingSafeEqual } from 'node:crypto';

function fromTracker(rawBody, signatureHeader, secret) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader || ''));
  return a.length === b.length &amp;&amp; timingSafeEqual(a, b);
}

// Express: read the raw body, not parsed JSON
app.post('/tracker-hook', express.raw({ type: 'application/json' }), (req, res) =&gt; {
  if (!fromTracker(req.body, req.get('X-Tracker-Signature'), process.env.TRACKER_WEBHOOK_SECRET)) return res.sendStatus(401);
  const event = JSON.parse(req.body);
  console.log(event.event, event.issue?.key);
  res.sendStatus(204);
});</pre>
</template>

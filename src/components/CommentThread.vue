<script setup>
// One comment thread on an issue: the top comment (or a "Comment deleted" placeholder), its replies (the first 3,
// then "Show N more replies"), reactions and a reply box. Edits, deletes and replies emit `changed` to reload.
import { ref, computed } from 'vue';
import { post, patch, del, session } from '../api.js';
import { changed as markChanged } from '../ui.js';
import { ago, fmtDateTime } from '../meta.js';
import Avatar from './Avatar.vue';
import Markdown from './Markdown.vue';
import MarkdownEditor from './MarkdownEditor.vue';
import CommentReactions from './CommentReactions.vue';
import { attempt } from '../composables/useAction.js';
import { plural } from '../plural.js';

const props = defineProps({
  thread: Object,
  replies: { type: Array, default: () => [] },
  issueKey: String,
  canComment: Boolean,
  canAdmin: Boolean,
});
const emit = defineEmits(['changed']);
const SHOWN = 3;
const expanded = ref(false);
const editing = ref(null);
const replying = ref(false);
const reply = ref('');

const replies = computed(() => props.replies);
const shownReplies = computed(() => (expanded.value ? replies.value : replies.value.slice(0, SHOWN)));
const hiddenCount = computed(() => replies.value.length - shownReplies.value.length);

async function save() {
  await attempt(async () => {
    await patch(`/api/comments/${editing.value.id}`, { body: editing.value.body });
    editing.value = null;
    emit('changed');
  });
}
async function remove(c) {
  if (!confirm(c.parentId ? 'Delete this reply?' : 'Delete this comment?')) return;
  await attempt(async () => {
    await del(`/api/comments/${c.id}`);
    emit('changed');
  });
}
async function sendReply() {
  if (!reply.value.trim()) return;
  await attempt(async () => {
    await post(`/api/issues/${props.issueKey}/comments`, { body: reply.value, parentId: props.thread.id });
    reply.value = '';
    replying.value = false;
    expanded.value = true;
    emit('changed');
    markChanged();
  });
}
</script>

<template>
  <div>
    <template v-for="c in [thread, ...shownReplies]" :key="c.id">
      <div class="flex gap-2" :class="c.parentId ? 'ml-6 mt-3 border-l-2 border-slate-200 pl-3 sm:ml-9' : ''">
        <Avatar v-if="!c.deleted" :user="c.author" :size="c.parentId ? 22 : 28" />
        <div class="min-w-0 flex-1">
          <p v-if="c.deleted" class="text-sm italic text-slate-500">Comment deleted</p>
          <template v-else>
            <div class="text-sm">
              <strong class="font-medium">{{ c.author?.name || 'Former user' }}</strong>
              <span v-if="c.internal" class="chip bg-amber-100 text-amber-900" title="Only team members see this. Guests do not."
                >Internal</span
              >
              <span
                v-if="c.source === 'mcp'"
                class="chip bg-violet-100 text-violet-900"
                title="Made by an AI assistant (MCP) acting for this person"
                >via AI assistant</span
              >
              <span class="text-xs text-slate-400" :title="fmtDateTime(c.createdAt)"
                >{{ ago(c.createdAt) }}<template v-if="c.updatedAt !== c.createdAt"> (edited)</template></span
              >
            </div>
            <div v-if="editing?.id === c.id">
              <MarkdownEditor
                v-model="editing.body"
                :rows="3"
                :issue-key="issueKey"
                :internal="c.internal"
                @submit="save"
                @uploaded="emit('changed')"
              />
              <div class="mt-1 flex gap-2">
                <button class="btn btn-primary btn-sm" @click="save">Save</button
                ><button class="btn btn-sm" @click="editing = null">Cancel</button>
              </div>
            </div>
            <Markdown v-else :text="c.body" />
            <CommentReactions :comment="c" :can-react="canComment" />
            <div v-if="editing?.id !== c.id" class="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
              <button v-if="canComment && !c.parentId && !replies.length" class="hover:underline" @click="replying = true">Reply</button>
              <button v-if="c.mine" class="hover:underline" @click="editing = { id: c.id, body: c.body }">Edit</button>
              <button v-if="c.mine || canAdmin" class="hover:underline" @click="remove(c)">Delete</button>
            </div>
          </template>
        </div>
      </div>
    </template>
    <button v-if="hiddenCount > 0" class="link ml-6 mt-2 text-xs sm:ml-9" @click="expanded = true">
      Show {{ hiddenCount }} more {{ plural(hiddenCount, 'reply', 'replies') }}
    </button>
    <div v-if="canComment && replying" class="ml-6 mt-3 flex gap-2 sm:ml-9">
      <Avatar :user="session.user" :size="22" />
      <div class="min-w-0 flex-1">
        <MarkdownEditor
          v-model="reply"
          :rows="2"
          :placeholder="thread.internal ? 'Reply (internal: only team members see it)' : 'Reply to this thread'"
          :issue-key="issueKey"
          :internal="thread.internal"
          :autofocus="replying"
          @submit="sendReply"
          @uploaded="emit('changed')"
        />
        <div class="mt-1 flex gap-2">
          <button class="btn btn-primary btn-sm" :disabled="!reply.trim()" @click="sendReply">Reply</button>
          <button
            v-if="replying"
            class="btn btn-sm"
            @click="
              replying = false;
              reply = '';
            "
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
    <button v-else-if="canComment && replies.length" class="link ml-6 mt-2 block text-xs sm:ml-9" @click="replying = true">
      Reply to thread
    </button>
  </div>
</template>

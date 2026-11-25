<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { renderMarkdown } from '../markdown.js';
const props = defineProps({ text: String, tasks: Boolean });
const emit = defineEmits(['toggle-task']);
const html = computed(() => {
  const h = renderMarkdown(props.text);
  // checklists are clickable when the parent can save them
  return props.tasks ? h.replace(/<input[^>]*>/g, (m) => (m.includes('checkbox') ? m.replace(' disabled=""', '') : m)) : h;
});
const router = useRouter();
function click(e) {
  if (props.tasks && e.target.matches('input[type=checkbox]')) {
    e.stopPropagation();
    const boxes = [...e.currentTarget.querySelectorAll('input[type=checkbox]')];
    emit('toggle-task', boxes.indexOf(e.target), e.target.checked);
    return;
  }
  const a = e.target.closest('a');
  if (a && a.getAttribute('href')?.startsWith('/') && !a.getAttribute('href').startsWith('/api/') && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    router.push(a.getAttribute('href'));
  }
}
</script>
<template>
  <div class="md" v-html="html" @click="click"></div>
</template>

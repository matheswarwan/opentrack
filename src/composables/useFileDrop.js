// Dropping files from the desktop onto an area: `dragging` is true while files hover over it (for an
// outline), and onFiles(fileList) gets what was dropped. enabled() says whether drops are accepted now.
// Bind the four handlers to the area: @dragenter @dragover @dragleave @drop.
import { ref, onMounted, onBeforeUnmount } from 'vue';

export function useFileDrop({ enabled, onFiles }) {
  const dragging = ref(false);
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0; // dragenter/dragleave fire for every child element
  function onDragEnter(e) {
    if (!enabled() || !hasFiles(e)) return;
    dragDepth++;
    dragging.value = true;
  }
  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dragging.value = false;
  }
  function onDragOver(e) {
    if (!enabled() || !hasFiles(e)) return;
    e.preventDefault();
  }
  const endDrag = () => {
    dragDepth = 0;
    dragging.value = false;
  };
  function onDrop(e) {
    endDrag();
    if (!enabled() || !hasFiles(e)) return;
    e.preventDefault();
    onFiles(e.dataTransfer.files);
  }
  // a drag that ends anywhere else (dropped outside, cancelled, window left) clears the outline
  const EVENTS = ['dragend', 'drop', 'blur'];
  onMounted(() => EVENTS.forEach((name) => window.addEventListener(name, endDrag)));
  onBeforeUnmount(() => EVENTS.forEach((name) => window.removeEventListener(name, endDrag)));
  return { dragging, onDragEnter, onDragOver, onDragLeave, onDrop };
}

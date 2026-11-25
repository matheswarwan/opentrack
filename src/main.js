import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.js';
import './style.css';
import { installErrorCapture } from './diagnostics.js';
import { loadFonts } from './brand.js';
import { installStaleChunkReload } from './staleChunk.js';
import { bindRouter } from './ui.js';

installErrorCapture();
loadFonts();

installStaleChunkReload(router);
bindRouter(router);
createApp(App).use(router).mount('#app');

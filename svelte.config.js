import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    // Reduce runtime by emitting accessors + runes mode for Svelte 5.
    runes: true,
  },
};

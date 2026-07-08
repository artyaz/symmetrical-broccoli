import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Vite config tuned for "blazing fast" initial load:
// - Manual chunk splitting keeps the entry chunk small (<14kb gzipped target).
// - All heavy code (PeerJS, card data, Three-style anim helpers) is split into
//   lazy-loaded chunks that the browser only fetches once the SPA shell is up.
// - `modern` polyfill target strips IE / legacy cruft.
// - `sourcemap` enabled for development only (kept off in production for size).

// GitHub Pages serves this project at /<repo-name>/, not at the domain root.
// Derive `base` from GITHUB_REPOSITORY (format: "owner/repo"). When developing
// locally GITHUB_REPOSITORY is unset, so `base` falls back to '/'.
// NOTE: the app uses hash routing, so no SPA fallback is needed on Pages —
// every route lives after the `#` and is resolved client-side.
const repo = process.env.GITHUB_REPOSITORY || '';
const base = repo ? `/${repo.split('/')[1]}/` : '/';

export default defineConfig({
  base,
  plugins: [svelte()],
  build: {
    target: 'es2022',
    cssCodeSplit: true,
    sourcemap: false,
    minify: 'oxc',
    assetsInlineLimit: 2048, // small assets inlined as base64 to cut requests
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Stable, content-hashed filenames so CDN caching is maximised.
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        // Manual chunks: keep the entry shell tiny, push everything else out.
        manualChunks(id) {
          if (id.includes('node_modules/peerjs')) return 'vendor-peer';
          if (id.includes('node_modules')) return 'vendor';
          if (id.includes('/src/lib/data/packs/')) return 'card-data';
          if (id.includes('/src/lib/data/')) return 'card-meta';
          if (id.includes('/src/lib/anim/')) return 'anim';
          if (id.includes('/src/lib/views/')) return 'views';
          if (id.includes('/src/lib/components/')) return 'ui';
          if (id.includes('/src/lib/net/')) return 'net';
        },
      },
    },
  },
  // Use Vite 8's default Oxc-based transforms; esbuild is deprecated.
  // (Setting `esbuild: false` has no effect in Vite 8 — left as a comment.)
  server: {
    host: true,
    port: 5173,
  },
});

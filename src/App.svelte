<script>
  // App.svelte — Top-level shell. Tiny by design.
  // Renders the current view from the route store. All view components are
  // lazy-loaded by the router, so the entry chunk stays small.

  import { onMount } from 'svelte';
  import { route, initRouter } from './lib/router.js';
  import { session } from './lib/stores/session.js';
  import { getPublicIP } from './lib/stores/session.js';

  let current;

  // Init router on mount (not at module load — keeps the entry chunk smaller).
  onMount(() => {
    initRouter();
    // Kick off the lazy IP fetch in the background; session.js caches it.
    getPublicIP();
  });

  // Cleanup hook for the active view (each view exposes an optional `leave`
  // via a custom event we listen for here — kept simple for now).
  function onViewChange(e) {
    // Future: dispatch analytics, transition hooks, etc.
  }
</script>

<main class="app" data-route={$route.name}>
  {#if $route.module}
    {@const View = $route.module}
    {@const viewProps = $route.params?.length ? { params: $route.params } : {}}
    <View {...viewProps} />
  {/if}
</main>

<style>
  :global(html, body) {
    background: var(--bg);
    color: var(--ink);
  }
  .app {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 100vh;
    min-height: 100dvh;
    overflow: hidden;
    /* The view-transition pseudo-elements get this name so we can target
       them globally for cross-view animations. */
    view-transition-name: app-root;
  }
  /* Reduce-motion: disable view transitions globally. */
  @media (prefers-reduced-motion: reduce) {
    :global(::view-transition-group(*)) {
      animation-duration: 0ms !important;
    }
  }
</style>

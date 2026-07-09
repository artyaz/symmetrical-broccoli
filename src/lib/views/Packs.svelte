<script>
  // Packs.svelte — Browse all available CAH packs. Lazy-loaded card data not
  // fetched here — we only show metadata (counts, year, official status).
  import { onMount } from 'svelte';
  import { navigate } from '../router.js';
  import { PACKS } from '../data/packs/index.js';

  let filter = $state('official'); // 'official' | 'all' | 'unofficial'
  let search = $state('');

  const filtered = $derived.by(() => {
    let list = PACKS;
    if (filter === 'official') list = list.filter((p) => p.official);
    if (filter === 'unofficial') list = list.filter((p) => !p.official);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    return list;
  });

  const totals = $derived.by(() => {
    let w = 0, b = 0;
    for (const p of filtered) { w += p.white; b += p.black; }
    return { w, b, n: filtered.length };
  });
</script>

<main class="packs">
  <header>
    <button class="back" onclick={() => navigate('/')}>← back</button>
    <h2>packs</h2>
    <div class="spacer"></div>
    <input
      type="text"
      bind:value={search}
      placeholder="search…"
      autocomplete="off"
      spellcheck="false"
    />
  </header>

  <div class="filters">
    <button class:active={filter === 'official'} onclick={() => (filter = 'official')}>official</button>
    <button class:active={filter === 'all'} onclick={() => (filter = 'all')}>all</button>
    <button class:active={filter === 'unofficial'} onclick={() => (filter = 'unofficial')}>unofficial</button>
    <span class="count">{totals.n} packs · {totals.w} white · {totals.b} black</span>
  </div>

  <ul class="grid">
    {#each filtered as p (p.slug)}
      <li class:official={p.official}>
        <div class="head">
          <span class="name">{p.name}</span>
          {#if p.official}<span class="badge">official</span>{/if}
        </div>
        <div class="meta">
          <span>{p.white} white</span>
          <span>·</span>
          <span>{p.black} black</span>
          {#if p.year}<span>·</span><span>{p.year}</span>{/if}
        </div>
        {#if p.description}<p class="desc">{p.description}</p>{/if}
      </li>
    {/each}
  </ul>
</main>

<style>
  .packs {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    min-height: 100dvh;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 18px;
    border-bottom: 1px solid var(--line);
  }
  .back {
    background: transparent;
    border: none;
    color: var(--ink-dim);
    font-family: var(--font);
    font-size: 13px;
    cursor: pointer;
  }
  .back:hover { color: var(--ink); }
  h2 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; }
  .spacer { flex: 1; }
  input {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--ink);
    font-family: var(--font);
    font-size: 13px;
    padding: 6px 10px;
    width: 200px;
    outline: none;
  }
  input:focus { border-color: var(--ink); }
  .filters {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }
  .filters button {
    background: transparent;
    border: 1px solid var(--line);
    color: var(--ink);
    font-family: var(--font);
    font-size: 11px;
    padding: 5px 10px;
    border-radius: 999px;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .filters button.active {
    background: var(--ink);
    color: var(--bg);
    border-color: var(--ink);
  }
  .count {
    margin-left: auto;
    font-size: 11px;
    color: var(--ink-dim);
    letter-spacing: 0.06em;
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: 16px 18px 40px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
    overflow-y: auto;
    flex: 1;
  }
  li {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    background: rgba(255, 255, 255, 0.02);
    transition: border-color 200ms ease, transform 200ms ease;
  }
  li:hover {
    border-color: rgba(255, 255, 255, 0.2);
    transform: translateY(-1px);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
  }
  .name { font-size: 13px; font-weight: 600; line-height: 1.3; }
  .badge {
    font-size: 8px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    background: var(--ink);
    color: var(--bg);
    padding: 2px 6px;
    border-radius: 4px;
    flex-shrink: 0;
  }
  .meta {
    margin-top: 6px;
    display: flex;
    gap: 4px;
    font-size: 11px;
    color: var(--ink-dim);
  }
  .desc {
    margin: 8px 0 0;
    font-size: 11px;
    color: var(--ink-dim);
    line-height: 1.4;
  }
</style>

<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<main>
  {@render children()}
</main>

<footer>
  <a href="https://github.com/DanielCraft221/Webmail-Cloudflare">Código-fonte (AGPL-3.0)</a>
</footer>

<style>
  :global(body) {
    font-family: system-ui, sans-serif;
    margin: 0;
    color: #1a1a1a;
    background: #f6f6f4;
  }
  main {
    max-width: 26rem;
    margin: 3rem auto;
    padding: 0 1rem;
  }
  footer {
    text-align: center;
    font-size: 0.85rem;
    padding: 2rem 1rem;
  }
</style>

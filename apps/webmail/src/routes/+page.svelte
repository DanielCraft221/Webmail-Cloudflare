<script lang="ts">
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
</script>

<svelte:head><title>Webmail</title></svelte:head>

<h1>Webmail</h1>
<p>Conectado como <strong>{data.displayName ?? data.username}</strong>.</p>
<form method="POST" action="/logout">
  <button type="submit">Sair</button>
</form>

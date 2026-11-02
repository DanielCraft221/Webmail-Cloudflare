<script lang="ts">
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  type Address = { address: string; name: string | null };
  // Always the real address next to the name, never the name alone (no "verified" seal: Etapa 6).
  const show = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address);
  const kib = (bytes: number) =>
    bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
</script>

<svelte:head><title>{data.subject ?? "(sem assunto)"} · Webmail</title></svelte:head>

<article>
  <h1>{data.subject ?? "(sem assunto)"}</h1>
  <dl>
    <dt>De</dt>
    <dd>{data.from ? show(data.from) : "(remetente desconhecido)"}</dd>
    <dt>Para</dt>
    <dd>{data.to.map(show).join(", ") || "(ninguém)"}</dd>
    {#if data.cc.length > 0}
      <dt>Cc</dt>
      <dd>{data.cc.map(show).join(", ")}</dd>
    {/if}
    <dt>Data</dt>
    <dd>{data.date ?? data.receivedAt}</dd>
  </dl>

  <!-- Layer 3: no allow-scripts, no allow-same-origin; links open in a new tab, outside the sandbox. -->
  <iframe
    title="Conteúdo da mensagem"
    src="/mensagens/{data.id}/corpo"
    sandbox="allow-popups allow-popups-to-escape-sandbox"
    referrerpolicy="no-referrer"
  ></iframe>

  {#if data.attachments.length > 0}
    <h2>Anexos</h2>
    <ul>
      {#each data.attachments as attachment (attachment.id)}
        <li>
          <a href="/mensagens/{data.id}/anexos/{attachment.id}" download data-sveltekit-reload>
            {attachment.filename ?? "anexo"}
          </a>
          ({kib(attachment.size)})
        </li>
      {/each}
    </ul>
  {/if}
  <p><a href="/mensagens/{data.id}/eml" download data-sveltekit-reload>Baixar o original (.eml)</a></p>
</article>

<style>
  iframe {
    width: 100%;
    min-height: 60vh;
    border: 1px solid #ccc;
    background: #fff;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.75rem;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>

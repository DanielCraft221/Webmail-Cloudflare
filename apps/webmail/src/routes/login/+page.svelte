<script lang="ts">
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Entrar · Webmail</title></svelte:head>

<h1>Entrar</h1>

{#if data.setupDone}
  <p role="status">Configuração concluída. Entre com a sua senha e o código do aplicativo.</p>
{/if}
{#if form?.message}
  <p role="alert">{form.message}</p>
{/if}

<form method="POST">
  <label>
    Usuário
    <input name="username" autocomplete="username" required value={form?.username ?? ""} />
  </label>
  <label>
    Senha
    <input name="password" type="password" autocomplete="current-password" required />
  </label>
  <label>
    Código do aplicativo
    <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" required />
  </label>
  <button type="submit">Entrar</button>
</form>

<style>
  form {
    display: grid;
    gap: 1rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
  }
  [role="alert"] {
    color: #a40000;
  }
</style>

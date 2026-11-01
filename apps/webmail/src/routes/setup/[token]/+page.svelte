<script lang="ts">
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Configurar acesso · Webmail</title></svelte:head>

<h1>Configurar acesso</h1>

{#if !data.valid}
  <p role="alert">Este link de configuração não vale mais. Peça um novo ao administrador.</p>
{:else}
  <p>Usuário: <strong>{data.username}</strong></p>

  <ol>
    <li>Leia o QR code no aplicativo autenticador (Google Authenticator, Aegis, 2FAS…).</li>
    <li>Escolha uma senha de {data.minPassword} a {data.maxPassword} caracteres.</li>
    <li>Digite o código de 6 dígitos que o aplicativo mostrar.</li>
  </ol>

  <img src={data.qr} alt="QR code para o aplicativo autenticador" width="220" height="220" />
  <p>
    Sem câmera? Digite este segredo no aplicativo:
    <code data-testid="totp-secret">{data.secret}</code>
  </p>

  {#if form?.message}
    <p role="alert">{form.message}</p>
  {/if}

  <form method="POST">
    <label>
      Nova senha
      <input
        name="password"
        type="password"
        autocomplete="new-password"
        minlength={data.minPassword}
        maxlength={data.maxPassword}
        required
      />
    </label>
    <label>
      Repita a senha
      <input name="confirm" type="password" autocomplete="new-password" required />
    </label>
    <label>
      Código do aplicativo
      <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" required />
    </label>
    <button type="submit">Concluir</button>
  </form>
{/if}

<style>
  form {
    display: grid;
    gap: 1rem;
  }
  label {
    display: grid;
    gap: 0.25rem;
  }
  code {
    font-size: 1.1rem;
    word-spacing: 0.3rem;
  }
  [role="alert"] {
    color: #a40000;
  }
</style>

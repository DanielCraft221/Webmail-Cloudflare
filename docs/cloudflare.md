# Cloudflare: passo a passo da implantação

Roteiro para refazer a implantação do `mail-core` sozinho. Os comandos rodam em `apps/mail-core`.

Regra do projeto: todo comando que cria, altera ou apaga algo na Cloudflare é mostrado e só roda depois de um "ok".

## 1. API Token do Wrangler

O servidor não tem navegador, então o Wrangler usa um API Token em vez do `wrangler login`.

1. No painel, crie um **Account API Token** personalizado. O que foi criado em 2026-10-28 tem:
   - **Permissões de conta:**
     - Workers Scripts: Edit
     - D1: Edit
     - Workers R2 Storage: Edit
     - Queues: Edit
     - Workers Tail: Read
     - User Details: Read
   - **Permissões de zona:** nenhuma. O Email Routing é configurado pelo painel (seção 5).
   - **Validade:** até 2026-11-30.
2. Guarde o token num arquivo fora do repositório, criado já com permissão 600:

   ```bash
   mkdir -p ~/.config/cloudflare
   install -m 600 /dev/null ~/.config/cloudflare/wrangler.env
   nano ~/.config/cloudflare/wrangler.env   # CLOUDFLARE_API_TOKEN=... e CLOUDFLARE_ACCOUNT_ID=...
   ```

3. Carregue o arquivo só no terminal que vai usar, e teste:

   ```bash
   set -a; . ~/.config/cloudflare/wrangler.env; set +a
   pnpm exec wrangler whoami
   ```

   O resultado esperado é "You are logged in with an Account API Token". Nunca imprima o arquivo nem cole o conteúdo dele em lugar nenhum.

Ao renovar o token, atualize o inventário em `docs/segredos.md`.

## 2. Recursos (criados em 2026-10-28)

```bash
pnpm exec wrangler d1 create webmail-db --location enam --no-update-config
pnpm exec wrangler r2 bucket create webmail-mail --location enam --no-update-config
pnpm exec wrangler r2 bucket dev-url get webmail-mail   # deve dizer "disabled"
pnpm exec wrangler queues create mail-ingest --message-retention-period-secs 1209600
pnpm exec wrangler queues create mail-ingest-dlq --message-retention-period-secs 1209600
```

- `enam` (leste da América do Norte) é a região mais próxima do Brasil entre as opções.
- `--no-update-config` impede o Wrangler de editar o `wrangler.jsonc`. O `database_id` foi colocado por PR.
- O bucket é privado: sem acesso público e sem a URL `r2.dev`.
- As duas filas guardam mensagens por 14 dias (1.209.600 s), o máximo do plano pago. A DLQ não tem consumidor, então esse é o prazo para notar uma falha.

**Para desfazer** (nesta ordem, e só se não houver e-mail guardado):

```bash
pnpm exec wrangler queues delete mail-ingest-dlq
pnpm exec wrangler queues delete mail-ingest
pnpm exec wrangler r2 bucket delete webmail-mail   # só funciona com o bucket vazio
pnpm exec wrangler d1 delete webmail-db
```

## 3. Banco remoto

```bash
pnpm exec wrangler d1 migrations apply webmail-db --remote
pnpm exec wrangler d1 execute webmail-db --remote --file seed/0001_survivus.sql
```

As migrações aplicadas ficam registradas na tabela `d1_migrations`. O seed usa `INSERT OR IGNORE`, então pode ser rodado de novo sem duplicar.

## 4. Deploy e endereço de reserva

```bash
pnpm exec wrangler deploy
```

O deploy sai sempre da `main` atualizada, nunca de um branch sem revisão.

Depois do primeiro deploy, configure o secret do endereço de reserva. Rode você mesmo, porque o comando pede o valor no terminal e ele nunca deve aparecer no chat:

```bash
pnpm exec wrangler secret put FALLBACK_FORWARD_TO
```

O endereço precisa ser um **destino verificado** no Email Routing (seção 5.1) e não pode ser de `survivus.com.br`, senão o encaminhamento voltaria para o próprio Worker.

## 5. Email Routing pelo painel

O token não tem permissões de zona, então estes passos são feitos à mão no painel da Cloudflare.

### 5.1 Verificar o endereço de reserva

1. Abra **Compute** › **Email Service** › **Email Routing** › **Destination Addresses**.
2. Em **Destination addresses**, digite o endereço de reserva e envie.
3. Abra o e-mail de verificação que a Cloudflare manda e clique em **Verify email address**.
4. Confira se o endereço aparece como verificado. Enquanto ele está pendente, o `forward()` para ele falha.

### 5.2 Antes de ativar: conferir o DNS atual

```bash
dig +short MX survivus.com.br
dig +short TXT survivus.com.br
```

O domínio só pode ter **um** registro SPF (`v=spf1 ...`). Se já existir um, pare e decida antes de continuar. Anote os MX atuais: são eles que voltam se o Email Routing for desligado.

### 5.3 Ativar o Email Routing

1. Abra **Compute** › **Email Service** › **Email Routing**.
2. Clique em **Onboard Domain** e escolha `survivus.com.br`.
3. Revise os registros DNS que serão criados: MX para a Cloudflare, TXT de SPF e TXT de DKIM.
4. Clique em **Done**.
5. Confira de novo com `dig` (seção 5.2). A propagação costuma levar de 5 a 15 minutos.

### 5.4 Catch-all para o Worker

O Worker `mail-core` precisa estar publicado (seção 4) para aparecer na lista.

1. Em **Email Routing**, escolha `survivus.com.br` e abra a aba **Routing Rules**.
2. Ligue o **Catch-all rule** até ele aparecer como **Active**.
3. Em **Action**, escolha **Send to a Worker** e, em seguida, o Worker `mail-core`.
4. Clique em **Save**.

Não crie regras por endereço: quem decide se um endereço existe é o D1 (`docs/decisoes.md`).

**Para desfazer:** desligue o catch-all na mesma tela. Se desligar o Email Routing do domínio, confira o DNS depois com `dig` e compare com o que foi anotado na seção 5.2.

## 6. Logs

O `wrangler.jsonc` liga o `observability`, então os logs do Worker ficam guardados no painel em **Workers Logs**. Só os nossos `log()` são guardados: têm o UUID da mensagem, a caixa, o domínio do remetente, o tamanho e o status.

Os *invocation logs* (o registro automático de cada execução) ficam **desligados** (`invocation_logs: false`). O evento de e-mail traz o remetente completo do envelope (`mailFrom`), e a regra do projeto proíbe guardar esse endereço.

Para acompanhar ao vivo:

```bash
pnpm exec wrangler tail mail-core
```

O `tail` não guarda nada, mas **mostra** o evento com o `mailFrom` no terminal. Use só durante os testes e não cole a saída em lugar público.

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
pnpm exec wrangler d1 execute webmail-db --remote --file seed/0002_daniel.sql   # Etapa 3
```

As migrações aplicadas ficam registradas na tabela `d1_migrations`. O seed usa `INSERT OR IGNORE`, então pode ser rodado de novo sem duplicar.

## 4. Deploy

```bash
pnpm exec wrangler deploy
```

O deploy sai sempre da `main` atualizada, nunca de um branch sem revisão. Secrets do `mail-core`: `INTERNAL_API_TOKEN`, `ACCESS_CLIENT_ID` e `ACCESS_AUD` (seção 8).

### Workers descartáveis (testes)

Um Worker de teste fora do repositório se apaga **pelo painel**, na página do Worker. O `wrangler delete` falha com este token: antes de apagar, ele tenta listar namespaces KV, e o token não tem permissão de KV. Apague antes as regras do Email Routing que apontam para ele.

## 5. Email Routing pelo painel

O token não tem permissões de zona, então estes passos são feitos à mão no painel da Cloudflare.

### 5.1 Antes de ativar: conferir o DNS atual

```bash
dig +short MX survivus.com.br
dig +short TXT survivus.com.br
```

O domínio só pode ter **um** registro SPF (`v=spf1 ...`). Se já existir um, pare e decida antes de continuar. Anote os MX atuais: são eles que voltam se o Email Routing for desligado.

### 5.2 Ativar o Email Routing

1. Abra **Compute** › **Email Service** › **Email Routing**.
2. Clique em **Onboard Domain** e escolha `survivus.com.br`.
3. Revise os registros DNS que serão criados: MX para a Cloudflare, TXT de SPF e TXT de DKIM.
4. Clique em **Done**.
5. Confira de novo com `dig` (seção 5.1). A propagação costuma levar de 5 a 15 minutos.

### 5.3 Catch-all para o Worker

O Worker `mail-core` precisa estar publicado (seção 4) para aparecer na lista.

1. Em **Email Routing**, escolha `survivus.com.br` e abra a aba **Routing Rules**.
2. Ligue o **Catch-all rule** até ele aparecer como **Active**.
3. Em **Action**, escolha **Send to a Worker** e, em seguida, o Worker `mail-core`.
4. Clique em **Save**.

Não crie regras por endereço: quem decide se um endereço existe é o D1 (`docs/decisoes.md`).

**Para desfazer:** desligue o catch-all na mesma tela. Se desligar o Email Routing do domínio, confira o DNS depois com `dig` e compare com o que foi anotado na seção 5.1.

## 6. Conferir as mensagens recebidas

```bash
pnpm --filter mail-core inbox:list
```

Lista as 20 últimas mensagens do D1 remoto: data, caixa, domínio do remetente, assunto, pasta, `parse_status`, `spf`, `dkim` e `dmarc`. Só lê (`SELECT`). Não mostra corpo nem o endereço completo do remetente.

## 7. Logs

O `wrangler.jsonc` liga o `observability`, então os logs do Worker ficam guardados no painel em **Workers Logs**. Só os nossos `log()` são guardados: têm o UUID da mensagem, a caixa, o domínio do remetente, o tamanho e o status.

Os *invocation logs* (o registro automático de cada execução) ficam **desligados** (`invocation_logs: false`). O evento de e-mail traz o remetente completo do envelope (`mailFrom`), e a regra do projeto proíbe guardar esse endereço.

Para acompanhar ao vivo:

```bash
pnpm exec wrangler tail mail-core
```

O `tail` não guarda nada, mas **mostra** o evento com o `mailFrom` no terminal. Use só durante os testes e não cole a saída em lugar público.

## 8. API interna (Etapa 3, PR 2)

Roteiro para o PR 2. As telas do painel são as da documentação em 2026-10-29 (`docs/cloudflare-api.md`): confira na hora e corrija aqui o que tiver mudado.

### 8.1 Segredos, gerados por você

O valor vai direto para o arquivo, sem aparecer na tela nem passar pela área de transferência (`printf` é do próprio shell, então também não aparece no `ps`):

```bash
install -d -m 700 ~/.config/webmail
install -m 600 /dev/null ~/.config/webmail/api.env
printf 'INTERNAL_API_TOKEN=%s\n' "$(openssl rand -base64 48)" > ~/.config/webmail/api.env
grep -c '^INTERNAL_API_TOKEN=.\{64\}$' ~/.config/webmail/api.env   # esperado: 1
```

Secret no Worker, lendo do arquivo pelo pipe. Os parênteses tiram o token da Cloudflare do shell no fim:

```bash
cd apps/mail-core
(
  set -a; . ~/.config/cloudflare/wrangler.env; set +a
  . ~/.config/webmail/api.env
  printf '%s' "$INTERNAL_API_TOKEN" | WRANGLER_SEND_METRICS=false pnpm exec wrangler secret put INTERNAL_API_TOKEN
)
```

Todo `wrangler secret put` publica uma nova versão do código que está no ar, com o secret novo.

### 8.2 Domínio da API

1. Workers & Pages › `mail-core` › **Settings** › **Domains & Routes** › **Add** › **Custom Domain**.
2. Digite `mail-api.survivus.com.br` e confirme. A Cloudflare cria o DNS e o certificado.
3. O hostname não pode ter um CNAME antes.

### 8.3 Cloudflare Access

1. **Service Token:**
   - Zero Trust › **Access controls** › **Service credentials** › **Service Tokens** › **Create Service Token**.
   - Nome `webmail`, depois **Generate token**.
   - O Client Secret aparece **uma vez só**. Grave os dois no `api.env` sem que apareçam no terminal (o `read -s` não mostra o que é colado e não vai para o histórico):

     ```bash
     read -rsp 'Client ID: ' id; echo
     read -rsp 'Client Secret: ' secret; echo
     printf 'CF_ACCESS_CLIENT_ID=%s\nCF_ACCESS_CLIENT_SECRET=%s\n' "$id" "$secret" >> ~/.config/webmail/api.env
     unset id secret
     ```
   - Depois copie qualquer outro texto, para tirar o secret da área de transferência.
2. **Aplicação:**
   - Tipo self-hosted, no hostname `mail-api.survivus.com.br`.
   - Uma política com ação **Service Auth**, incluindo só o token `webmail`.
   - Nenhuma outra política e nenhum login method.
   - Se houver a opção de autenticação estrita por service token, ligue: falha responde 401/403, sem redirecionar para login.
   - **Medido em 2026-10-29:** sem Service Token, o Access responde `403` com `cf-access-domain` e `cf-access-aud`, sem chegar ao Worker.
3. **Valores para o Worker:**
   - `ACCESS_TEAM_DOMAIN` entra como `vars` no `wrangler.jsonc`, por PR. Tem o formato `https://<equipe>.cloudflareaccess.com`.
   - `ACCESS_AUD` (o AUD tag da aplicação) é **secret** do Worker, gravado do `api.env` (`ACCESS_AUD=...`). Não é segredo de verdade, mas no `wrangler.jsonc` o gitleaks o barra, e não abrimos exceção no scanner (`docs/decisoes.md`).
   - Valores atuais: team domain `https://survivus-services.cloudflareaccess.com`, aplicação `mail-api`.
   - O `pnpm --filter @webmail/mail-core types` roda `wrangler types --strict-vars=false`: os `vars` viram `string`, e os testes podem trocar os valores.
4. **Client ID e AUD como secrets**, igual ao 8.1, trocando a última linha por:

   ```bash
   printf '%s' "$CF_ACCESS_CLIENT_ID" | WRANGLER_SEND_METRICS=false pnpm exec wrangler secret put ACCESS_CLIENT_ID
   printf '%s' "$ACCESS_AUD" | WRANGLER_SEND_METRICS=false pnpm exec wrangler secret put ACCESS_AUD
   ```

### 8.4 Banco e deploy

```bash
pnpm exec wrangler d1 migrations apply webmail-db --remote
pnpm exec wrangler d1 execute webmail-db --remote --file seed/0002_daniel.sql
pnpm exec wrangler deploy   # da main atualizada e limpa
```

Depois do deploy, confira que o Custom Domain continua ligado: a documentação não diz o que o deploy faz com um domínio criado pelo painel.

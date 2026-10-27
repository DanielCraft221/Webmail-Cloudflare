# Etapa 2: Worker de recebimento (`survivus.com.br` → R2 + D1)

> **Pré-requisito:** Etapa 1 validada (CI verde, hook do gitleaks bloqueando segredos, `docs/progresso.md` apontando para a Etapa 2).
> As regras permanentes estão em `CLAUDE.md`. Siga-as durante toda a etapa.

## Objetivo

Receber os e-mails enviados para `contato@`, `suporte@` e `compras@survivus.com.br` e guardá-los **sem perder nenhum**: mensagem bruta e anexos no R2, metadados no D1. Endereços que não existem são recusados.

**Fora desta etapa:** API de leitura (Etapa 3), envio (Etapas 4 e 8), usuários e permissões (Etapa 3), webmail (Etapa 5), outros domínios (Etapas 11 e 12), limpeza automática de mensagens antigas (vai para "Depois").

## Antes de começar

1. Na `main`, rode `git pull --ff-only`. Leia o `docs/progresso.md` e confirme que a Etapa 1 está concluída. Se não estiver, pare e me avise.
2. Crie o branch `etapa-2/recebimento` e mova este arquivo para `docs/etapas/etapa-2.md` nele.
3. Faça a **pesquisa da tarefa 1** antes de escrever qualquer código.
4. Apresente o plano em tópicos curtos, com o que descobriu na pesquisa, e **espere minha aprovação**.

## Fluxo desta etapa: dois PRs

- **PR 1, código (branch `etapa-2/recebimento`):** pesquisa, scaffold, migração, seed, handler, testes e documentação. **Nenhuma mudança na Cloudflare.** Rode a skill `security-audit` antes de abrir o PR. Eu reviso e faço o merge.
- **PR 2, implantação (branch `etapa-2/deploy`, criado a partir da `main` já com o PR 1):** criação do D1 e do R2, migração remota, deploy, Email Routing, teste ponta a ponta, `inbox:list` e ajustes descobertos no teste real.
- **Tudo que é enviado para a Cloudflare sai do código que já passou por PR.** Nunca faça deploy de um branch que eu ainda não revisei.

## Decisões já tomadas (não reabra sem me perguntar)

- **Regra catch-all do Email Routing → Worker.** Quem decide se o endereço existe é o D1, não regras fixas no painel. Endereço inexistente é recusado com `setReject` durante a conversa SMTP (o remetente recebe o erro na hora; nós não geramos e-mail de retorno).
- **Nunca perder e-mail.** O `.eml` bruto vai para o R2 **antes** de qualquer outra coisa. Se o parsing falhar, a mensagem é registrada mesmo assim, com `parse_status = 'failed'`.
- **Erro interno nunca vira `setReject`.** `setReject` é recusa **permanente**. Se o R2 ou o D1 falharem, o comportamento deve fazer o remetente **tentar de novo depois** (confirme na pesquisa como conseguir isso).
- **Identificadores não são segredos.** O `database_id` do D1 e o nome do bucket R2 podem ficar no `wrangler.jsonc` commitado: sem o token, eles não dão acesso a nada. O `account_id` **não** vai para o repositório: vem da variável `CLOUDFLARE_ACCOUNT_ID`. Registre isso no `docs/decisoes.md`.
- **Nada de HTTP nesta etapa.** O handler `fetch` responde 404 para tudo. `workers_dev: false` e nenhuma rota.

## Tarefas

### 1. Pesquisa na documentação oficial (PR 1, antes do código)

Confira na documentação **atual** da Cloudflare e registre em `docs/cloudflare-email-routing.md`, com os links:

- Assinatura do handler `email(message, env, ctx)` e o que o `message` oferece (`from`, `to`, `headers`, `raw`, `rawSize`, `setReject`).
- O `message.raw` é um stream que **só pode ser lido uma vez**: leia para um `ArrayBuffer`, grave no R2 e faça o parsing a partir desse buffer.
- **O que acontece quando o handler lança uma exceção:** o remetente recebe falha temporária (e tenta de novo) ou a mensagem se perde? Isso define o tratamento de erro da tarefa 4. Se a documentação não for clara, diga isso no plano e proponha um teste real.
- **Quais cabeçalhos de autenticação o Email Routing entrega ao Worker** (ex.: `Authentication-Results`, `ARC-*`, `Received-SPF`) e em que formato vêm os resultados de SPF, DKIM e DMARC. Não suponha: se não estiver documentado, o teste ponta a ponta (tarefa 7) vai mostrar, e o código se ajusta.
- Limites: tamanho máximo de mensagem recebida (a documentação cita 25 MiB), CPU e memória do Worker no plano pago.
- Formato atual de configuração do Wrangler (`wrangler.jsonc`), migrações do D1 e como testar o handler `email` com `@cloudflare/vitest-pool-workers`.

### 2. Acesso do Wrangler à Cloudflare (PR 2; servidor sem navegador)

- O `wrangler login` não funciona bem num servidor sem interface. Use um **API Token**.
- Me diga **exatamente quais permissões** o token precisa (o mínimo para Workers, D1, R2 e Email Routing desta etapa), e eu crio no painel.
- O token fica num arquivo fora do repositório, criado por mim:
  ```bash
  mkdir -p ~/.config/cloudflare
  install -m 600 /dev/null ~/.config/cloudflare/wrangler.env
  nano ~/.config/cloudflare/wrangler.env   # CLOUDFLARE_API_TOKEN=... e CLOUDFLARE_ACCOUNT_ID=...
  ```
  Carregado só na sessão que vai usar: `set -a; . ~/.config/cloudflare/wrangler.env; set +a`.
- **Você nunca lê, imprime nem copia esse arquivo.** Se precisar testar o acesso, use `wrangler whoami`.
- Registre o token no inventário do `docs/segredos.md` (nome, onde está, permissões, data), **sem o valor**.

### 3. Scaffold (PR 1) e recursos na Cloudflare (PR 2)

- **PR 1:** scaffold de `apps/mail-core` com TypeScript `strict`, Hono no `fetch` (só o 404 por enquanto) e `postal-mime`. No `wrangler.jsonc`, o `database_id` fica com um valor provisório claramente marcado; os testes usam os bindings locais e não precisam da Cloudflare.
- **PR 2 (cada comando: mostre e espere meu "ok"):**
  - D1: banco `webmail-db`. Substitua o `database_id` provisório pelo real.
  - R2: bucket `webmail-mail`, **privado**: sem acesso público, sem domínio `r2.dev`.

### 4. Banco de dados (PR 1: migração `0001`)

Tabelas mínimas desta etapa (usuários e permissões entram na Etapa 3):

- `domains`: domínio, ativo.
- `mailboxes`: endereço (único, sempre em minúsculas), domínio, nome de exibição, ativo, data de criação.
- `messages`: id (UUID), caixa, pasta (`inbox`, `spam`, `trash`, `archive`, `sent`, com `CHECK`), `Message-ID`, `In-Reply-To`, `References`, remetente (endereço e nome), destinatários (`to`, `cc` em JSON), assunto, trecho de até 200 caracteres, data do cabeçalho, data de recebimento, tamanho, tem anexos, resultados de SPF/DKIM/DMARC, lida (padrão não), chave do `.eml` no R2, chave do corpo no R2, `parse_status`.
  - **Índice único** em (caixa, `Message-ID`) para não duplicar.
  - Índice em (caixa, pasta, data de recebimento) para a listagem da Etapa 3.
- `attachments`: id, mensagem, nome do arquivo (só para exibição), tipo, tamanho, chave no R2, `Content-ID`, se é inline.

Os dados iniciais (`survivus.com.br` e as três caixas) entram por um arquivo SQL de seed separado da migração. Endereços de contato são públicos, então o seed pode ficar no repositório.

### 5. Handler `email` (PR 1)

Fluxo, nesta ordem:

1. Normalize o destinatário (`message.to`) para minúsculas e procure a caixa **ativa** no D1. Não existe → `setReject("Unknown recipient")` e fim.
2. `rawSize` acima do limite → `setReject` com mensagem clara. Documente o limite usado.
3. Pegue o `Message-ID` dos cabeçalhos. Se já existir para essa caixa → não faça nada (é duplicata) e registre no log.
4. Leia o `raw` uma vez para um `ArrayBuffer` e grave em `raw/AAAA/MM/<uuid>.eml` no R2. **Essa é sempre a primeira gravação.**
5. Sem `Message-ID`: gere um a partir do SHA-256 do conteúdo bruto, para a deduplicação funcionar mesmo assim.
6. Faça o parsing com `postal-mime` a partir do buffer.
   - Sucesso: corpo (`text` e `html`) em `body/<uuid>.json`; cada anexo em `att/<uuid>/<uuid-do-anexo>`, com o tipo nos metadados do objeto. **Nunca use o nome original do arquivo na chave do R2.**
   - Falha: registre a mensagem com `parse_status = 'failed'`, o assunto vindo dos cabeçalhos e o `.eml` já salvo. Nada se perde.
7. Leia os resultados de autenticação (conforme a pesquisa). **DMARC `fail` → pasta `spam`**, não `inbox`.
8. Grave a mensagem e os anexos no D1 numa **operação em lote** (tudo ou nada).
9. Erros de R2 ou D1: siga o que a pesquisa mostrou para gerar **falha temporária**. Nunca `setReject` por erro interno.

**Logs:** só UUID da mensagem, caixa, domínio do remetente, tamanho e status. **Nunca** assunto, corpo, nome de anexo ou endereço completo do remetente.

### 6. Testes (PR 1: Vitest + `@cloudflare/vitest-pool-workers`)

Arquivos `.eml` de exemplo em `apps/mail-core/test/fixtures/`, todos inventados (nada de e-mail real meu). Casos obrigatórios:

| Caso | Esperado |
|---|---|
| Destinatário inexistente | `setReject`, nada gravado no R2 nem no D1 |
| Destinatário em maiúsculas (`Contato@Survivus.com.br`) | Aceito na caixa certa |
| Texto simples | `.eml` + corpo no R2, linha em `messages` |
| HTML com anexo | Anexo no R2 com chave UUID, linha em `attachments` |
| Mesmo `Message-ID` duas vezes | Uma linha só |
| Sem `Message-ID` | Aceito, deduplicado pelo hash |
| MIME quebrado | `parse_status = 'failed'`, `.eml` guardado |
| DMARC falho | Pasta `spam` |
| Acima do limite de tamanho | `setReject` |
| Falha simulada do D1 | Não chama `setReject` |
| Logs | Não contêm assunto, corpo nem endereço completo do remetente |

### 7. Deploy e Email Routing (PR 2; cada passo: mostre e espere meu "ok")

1. Antes de mexer no DNS, **mostre os registros MX e TXT atuais** de `survivus.com.br`. Se já existir um registro SPF, pare e me avise: o domínio só pode ter **um**.
2. Aplique a migração e o seed no D1 **remoto**.
3. `wrangler deploy` do `mail-core`, com `workers_dev` desligado.
4. Ative o Email Routing em `survivus.com.br`. Mostre os registros DNS que ele criou.
5. Crie a regra **catch-all → Worker `mail-core`**.

### 8. Teste ponta a ponta (PR 2; eu faço, você me guia)

- Do meu Gmail para `contato@survivus.com.br`, com um anexo: aparece no D1 e no R2.
- Do Gmail para `naoexiste@survivus.com.br`: o Gmail me devolve um erro de entrega.
- Para conferir sem webmail, crie um script `pnpm --filter mail-core inbox:list` que lista as últimas mensagens do D1 remoto (data, caixa, remetente, assunto, pasta, `parse_status`). Ele só lê.
- Com uma mensagem real recebida, **confirme os cabeçalhos de autenticação de verdade** e ajuste o código e os testes se forem diferentes do que a pesquisa indicou.

### 9. Documentação (nos dois PRs, cada um com o que mudou)

- `docs/cloudflare-email-routing.md`: resultado da pesquisa (tarefa 1).
- `docs/cloudflare.md`: passo a passo do token, criação do D1 e R2, migrações, deploy e Email Routing, para eu conseguir refazer sozinho.
- `docs/arquitetura.md`: fluxo de recebimento detalhado, incluindo o que acontece em cada tipo de falha.
- `docs/decisoes.md`: catch-all no Worker, identificadores no repositório e `account_id` fora.
- `docs/segredos.md`: o token do Wrangler no inventário.
- `CLAUDE.md`: seção "Comandos" atualizada.
- `docs/progresso.md`: atualizado ao fim de cada sessão.

## Critérios de pronto

| Teste | Esperado |
|---|---|
| E-mail do Gmail para `contato@survivus.com.br` com anexo | Linha no D1, `.eml`, corpo e anexo no R2, em menos de 1 minuto |
| E-mail para endereço inexistente | O Gmail recebe erro de entrega |
| `pnpm --filter mail-core inbox:list` | Mostra a mensagem recebida |
| `pnpm lint && pnpm typecheck && pnpm test` | Tudo passa, com todos os casos da tarefa 6 |
| CI no GitHub | Verde |
| `https://mail-core.<conta>.workers.dev` | Não responde (workers.dev desligado) |
| Bucket R2 | Sem acesso público |
| DNS de `survivus.com.br` | Um único registro SPF |
| Logs do Worker (`wrangler tail` durante um envio) | Sem assunto, corpo nem endereço completo |
| `gitleaks` no histórico | Nenhum vazamento; token e `account_id` fora do repositório |
| `docs/progresso.md` | Etapa 2 concluída, próximo passo: Etapa 3 |

## Ao terminar

1. Mostre como eu mesmo testo cada critério acima, passo a passo.
2. Liste as dependências adicionadas e por que cada uma entrou.
3. Diga o que ficou pendente ou arriscado, principalmente o que a pesquisa não conseguiu confirmar.
4. **Pare.** Não comece a Etapa 3.

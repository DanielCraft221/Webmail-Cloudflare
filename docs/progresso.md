# Progresso

Atualizado ao fim de toda sessão: o que foi feito, o que falta e o próximo passo exato.

## Etapa atual: 5 (em andamento: PR 2, implantação do Worker)

### Próximo passo

PR 2 (`etapa-5/worker-deploy`), `docs/cloudflare.md` seção 9, cada passo na Cloudflare com o "ok" de Daniel:
- Feito: `admin.env` e `webmail.env` criados (9.1); `ADMIN_API_TOKEN` gravado no Worker (9.2).
- Feito: migração `0003` no D1 remoto (2026-11-01). Conferido: nenhuma pendente, colunas e índices novos existem, contagens iguais antes e depois (1 usuário, 7 mensagens, 3 caixas; `audit_log` vazio).
- **Ponto de restauração** (Time Travel, lido às 2026-11-01T12:41:14Z, logo antes da migração, válido até 2026-12-01): `00000018-00000000-00005116-75a348379796f1ae9cdc2e981d35c139`. Comando: `wrangler d1 time-travel restore webmail-db --bookmark=00000018-00000000-00005116-75a348379796f1ae9cdc2e981d35c139`. **Restaurar volta o D1 inteiro**: e-mails recebidos depois do marcador perdem a linha no D1 (o `.eml` fica no R2). Usar só logo depois de uma migração com problema; mais tarde, só com um plano de reprocessamento (`docs/cloudflare.md`, seção 9.3).
- Feito: deploy da `main` (`37d76bf`) em 2026-11-01. Versão anterior (código da Etapa 4 + secret novo): `2f832b04-2e59-440f-8f27-21fb6481d567`. Versão nova: `4ff110af-0455-4efa-b587-389197cb89ae`. Rollback: `pnpm exec wrangler rollback 2f832b04-2e59-440f-8f27-21fb6481d567`.
- `scripts/smoke-api.sh` ganhou os testes de `GET /v1/me` e da separação dos tokens (lê só o `ADMIN_API_TOKEN` do `admin.env`).
- Falta: Daniel roda `scripts/smoke-api.sh` (passo 6). Depois: push, PR 2, merge.

## Etapa 5: em andamento

### Feito (2026-10-31)

- Pesquisa da tarefa 1 em `docs/webmail-auth.md`: SvelteKit 3 / adapter-node 6, argon2id nativo do Node (medido: 64 MiB, t=3 = 166 ms), TOTP, cookie `__Host-` em localhost, Node LTS.
- Decisões de Daniel: ficar no Node 24 nesta etapa; `node:sqlite` em vez de `better-sqlite3` (o `CLAUDE.md` muda no PR 3); `@playwright/test` como devDependency, testes do navegador também na CI; coluna `source` no `audit_log`.
- PR 1: migração `0003`, rotas `/v1/auth/*`, `/v1/me`, `/v1/audit` e `/v1/admin/*` (incluindo `POST /v1/admin/audit` para as ações locais da CLI), testes e `docs/api.md`.
- PR 1 aprovado e no `main` (2026-11-01).
- PR 1 com push no `etapa-5/worker`. Lint, typecheck e testes (15 + 187) passam; gitleaks limpo. security-audit: um achado baixo corrigido (caracteres de controle no audit e no `displayName`). Nada mudou na Cloudflare.

### Falta

- PR 2: implantação do Worker (tarefa 7), em andamento.
- PR 3: webmail e CLI. Primeiro passo: testar se o SvelteKit e o `svelte-check` funcionam com o TypeScript 7.0.2; se não, TypeScript 6 só no `apps/webmail`.
- Tarefa 8 (conta real): o usuário do seed é **`danielcraft221`**, não `daniel`. O comando é `pnpm admin user:reset danielcraft221`.

## Etapa 4: concluída (2026-10-31)

### Feito (2026-10-30 e 2026-10-31)

- `git pull --ff-only` com "Cannot fast-forward to multiple branches": a configuração do git estava limpa e o erro não se repetiu. Sem mudança no config. Usar sempre `git pull --ff-only origin main`.
- Pesquisa em `docs/cloudflare-envio.md`.
- Email Sending: encontrado o `survivus.com.br` ativado (tentativa antiga). Daniel removeu pelo painel. Hoje só `mail.survivusmc.com` está ativado. O recebimento de `survivus.com.br` continuou funcionando (e-mail de teste com `spf`, `dkim` e `dmarc` = `pass`).
- DMARC de `mail.survivusmc.com`: mantido o `p=reject`, com o `rua` do DMARC Management.
- `scripts/smtp-test.sh`: token lido de arquivo `chmod 600` e passado ao `curl` por descritor (`-K`), nunca em argumento nem na saída. Confere o formato dos endereços.
- Testes com os tokens temporários `smtp-teste` e `smtp-teste-2`, já revogados (resultados em `docs/cloudflare-envio.md`):
  - Gmail: entregue na caixa de entrada. Outlook: entregue no **lixo eletrônico**, com tudo `pass`;
  - SPF, DKIM (`d=mail.survivusmc.com`) e DMARC `pass`, alinhados;
  - `contato@survivus.com.br` e `contato@survivusmc.com`: `550`;
  - token errado ou revogado: `535`.
- A Cloudflare substitui o `Message-ID` da mensagem. O script não gera mais um.
- `docs/smtp-servicos.md`: parâmetros, criação de token, nLogin (Crafty, dono do arquivo, backups, teste de entrega no Outlook), NodeBB e rotação.
- Decisão em `docs/decisoes.md`, inventário em `docs/segredos.md`, comando no `CLAUDE.md`.
- `.eml` de teste apagados do servidor.

### Falta

- **Tarefa 6 (nLogin): adiada.** O Crafty ainda não tem servidor. Nenhum token `smtp-nlogin` foi criado. Quando o servidor existir, seguir `docs/smtp-servicos.md`.
- NodeBB: não instalado.

### Riscos

- Outlook põe a mensagem no lixo. Medir com a recuperação real do nLogin.
- Cota de 200 envios por dia para a conta inteira. Sem cooldown de recuperação no nLogin, o relay interno vem antes do nLogin entrar no ar.
- Ativar o domínio principal `survivusmc.com` no Email Sending (Etapa 11) deixa os tokens do nLogin e do NodeBB enviarem como `contato@survivusmc.com`. Reavaliar antes, como na Etapa 12.

## Etapa 3: concluída (2026-10-29)

### Feito (2026-10-29)

- Tarefa 8, primeira investigação: a configuração no ar está certa (`logs.enabled`, `persist`, amostragem 100%, `invocation_logs: false`, lida pela API). O token não tem *Workers Observability*, então não deu para consultar os logs guardados. A causa provável é a visão do painel: sem *invocation logs*, a visão "Invocations" fica vazia. Daniel vai tentar a visão **Events** com o filtro `event` = `queued`.
- Pesquisa da tarefa 1 em `docs/cloudflare-api.md`.
- PR 1 (`etapa-3/api`):
  - migração `0002` (`users`, `user_mailboxes`, índice de paginação) e seed `0002_daniel.sql` (depois renomeado para `0002_danielcraft221.sql`);
  - middleware: JWT do Access estrito, bearer em tempo constante, usuário ativo, rate limit de 100/min por usuário;
  - as 7 rotas e 108 testes no mail-core;
  - `docs/api.md`, decisões e inventário de segredos.

### Feito (2026-10-29, PR 2)

- PR 1 mergeado. Também mergeado: regra contra `--no-verify` no `CLAUDE.md`.
- `~/.config/webmail/api.env` (`600`, pasta `700`) com `INTERNAL_API_TOKEN`, `CF_ACCESS_CLIENT_ID` e `CF_ACCESS_CLIENT_SECRET`, gerados por Daniel.
- Secrets do `mail-core`: `INTERNAL_API_TOKEN`, `ACCESS_CLIENT_ID` e `ACCESS_AUD`. O `ACCESS_AUD` virou secret porque o gitleaks o barrou no `wrangler.jsonc`, e não abrimos exceção.
- Custom Domain `mail-api.survivus.com.br` ligado ao `mail-core` pelo painel.
- Access: aplicação `mail-api`, Service Token `webmail`, política Service Auth. Opção "Retorna a Resposta 401" ligada: sem Service Token, `401` do Access (`text/html`, com `cf-access-domain`). Service Token válido por 1 ano.
- PR `etapa-3/deploy-vars` mergeado: `ACCESS_TEAM_DOMAIN` em `vars`, regra contra exceções no gitleaks no `CLAUDE.md`.
- Migração `0002` aplicada no D1 remoto (ponto de restauração abaixo). O seed ainda não rodou.
- Branch `etapa-3/seed-username`: username do seed trocado de `daniel` para `danielcraft221`, com o mesmo id. Arquivo renomeado para `seed/0002_danielcraft221.sql`.

### Feito (2026-10-29, deploy e testes)

- PR `etapa-3/deploy-vars` mergeado. PR `etapa-3/seed-username` mergeado: o primeiro usuário é `danielcraft221`, com o mesmo id.
- Na `main`: migração `0002` e seed `0002_danielcraft221.sql` remotos. O D1 tem 1 usuário (`admin`, ativo) com `can_read` nas 3 caixas.
- **Deploy:** versão `1ddd2b98-76ea-4f7a-b152-f6638efe5417`. A anterior, para rollback, era `4179dac6-c834-4be7-95b6-6d1500bf78d5` (código da Etapa 2 com os secrets). O Custom Domain continuou ligado.
- **Recebimento depois do deploy:** um e-mail real para `contato@` chegou com `parse_status` `ok` e `spf`, `dkim` e `dmarc` = `pass`.
- **Tarefa 7, todos os testes passaram:**
  - sem cabeçalho: `401` do Access (`text/html`);
  - só o Service Token: `401` JSON do Worker;
  - usuário inexistente: `401`;
  - `GET /v1/mailboxes` lista as 3 caixas;
  - mensagem do teste 1 da Etapa 2 lida com metadados e corpo;
  - anexo de 2.252.089 bytes com `octet-stream`, `attachment` e `nosniff`, do mesmo tamanho do D1;
  - `PATCH` de lida mudou a contagem de não lidas (5 → 4);
  - `workers.dev` responde `404`/`1042`.
  - Detalhes em `docs/api.md` ("Medido em produção").
- **Teste de fumaça:** `scripts/smoke-api.sh`, para rodar depois de todo deploy (`docs/cloudflare.md`, seção 8.5). Passou nos 11 testes contra produção e falhou como devia com usuário inválido.
- **Tarefa 8, controle positivo pela API** (token `logs-check`, só *Workers Observability Read*, que bastou para `telemetry/query`, ao contrário do que diz a referência da API):
  - Eventos de hoje: `api_request` (36), `queued` (1) e `ingested` (1). O controle positivo funcionou.
  - **Falhou:** a busca pelo **endereço completo** do remetente de teste achou o evento `queued`, nos campos `$workers.event.mailFrom` e `$metadata.trigger`. A Cloudflare acrescenta esses campos a todo `console.log` de uma invocação de e-mail, mesmo com `invocation_logs: false`. O nosso `log()` não grava o endereço; quem grava é a plataforma.
  - **Também falhou:** os `api_request` guardam `$workers.event.request.url` com o caminho (ids de mensagem) e a query string (`request.search.*`). Uma busca guardaria o termo pesquisado. A regra de `docs/api.md` proíbe isso.
  - A documentação dos Workers Logs não tem opção para excluir esses campos nem para apagar logs guardados. A retenção no plano pago é de 7 dias.

### Ponto de restauração do D1 (antes da migração `0002`)

- Bookmark do `webmail-db` em 2026-10-29T15:34:38Z, lido com `wrangler d1 time-travel info webmail-db`: `0000000d-00000000-00005113-3a1217d20dc99b47d1b81b2beffc1372`.
- Para voltar a este ponto (com "ok" antes, porque apaga tudo o que foi gravado depois, inclusive e-mails recebidos):

  ```bash
  pnpm exec wrangler d1 time-travel restore webmail-db --bookmark=0000000d-00000000-00005113-3a1217d20dc99b47d1b81b2beffc1372
  ```

### Feito (2026-10-29, logs e conclusão)

- PR `etapa-3/fechamento` mergeado: `scripts/smoke-api.sh` e os resultados das tarefas 7 e 8.
- PR `etapa-3/logs` mergeado:
  - armazenamento dos Workers Logs desligado (`observability.enabled: false`, `logs.enabled: false`);
  - busca passou para `POST /v1/search`, com o termo no corpo;
  - decisão em `docs/decisoes.md`.
- **Deploy:** versão `ccd940ec-66b4-4467-976a-c5d31f08a499`, às 21:25:10Z. A anterior, para rollback, é `1ddd2b98-76ea-4f7a-b152-f6638efe5417`. Depois do deploy, a API da Cloudflare mostra `observability: None` nas configurações do `mail-core`.
- **`smoke-api.sh`:** 13 PASS, incluindo `POST /v1/search` e `GET /v1/search` = `404`.
- **E-mail de teste** para `contato@` às 21:28:34Z: `parse_status` `ok`, com `spf`, `dkim` e `dmarc` = `pass`.
- **Tarefa 8, controle positivo depois do deploy** (token `logs-check`):
  - De 29/10 00:00Z até o deploy: 38 eventos guardados (`api_request` 36, `queued` 1, `ingested` 1). A consulta funciona.
  - Do deploy até 30/10 00:28Z: **0 eventos**. Nesse intervalo houve uns 20 pedidos do smoke e o e-mail de teste, então nenhum `queued`, `ingested` ou `api_request` novo foi guardado.
  - Os eventos antigos, com `mailFrom`, expiram pela retenção de 7 dias, até 2026-11-05.

### Falta

- _(nada da Etapa 3)_. Verificação que continua aberta, de antes: `Authentication-Results` forjado com o `authserv-id` da Cloudflare (`docs/cloudflare-email-routing.md`).

### Avisos para a Etapa 3

- Anexos servidos pela API sempre com `Content-Disposition: attachment` e `X-Content-Type-Options: nosniff`, para o navegador nunca abrir um anexo (HTML, SVG) como página do nosso domínio. **Feito no PR 1.**

## Etapa 2: concluída (2026-10-28)

### Feito (2026-10-27)

- Pesquisa da tarefa 1 em `docs/cloudflare-email-routing.md`, incluindo Queues e os pontos não documentados.
- Revisão do PR 1: deduplicação por `Message-ID` + cabeçalhos, duplicatas guardadas em `dup/`.
- Plano do PR 1 aprovado com duas mudanças: fila (Cloudflare Queues) entre o recebimento e o parse, e confiança só no `Authentication-Results` do topo com `authserv-id` confiável.
- PR 1 (branch `etapa-2/recebimento`): scaffold do `apps/mail-core`, migração `0001`, seed, handler `email`, consumidor da fila, 34 testes, documentação e `security-audit`.

### Feito (2026-10-28)

- PR 1 mergeado (com o complemento da deduplicação em `etapa-2/dedupe`).
- Token do Wrangler criado (Account API Token, sem permissões de zona, expira em 2026-11-30). `wrangler whoami` funcionando.
- Criados na Cloudflare: D1 `webmail-db` (`enam`), R2 `webmail-mail` (`enam`, `r2.dev` desligado), filas `mail-ingest` e `mail-ingest-dlq` (retenção de 14 dias).
- PR 2a (`etapa-2/deploy-config`) mergeado: `database_id` real, `observability` ligado, `docs/cloudflare.md`.
- Na `main`: migração e seed remotos, deploy do `mail-core`, Email Routing e catch-all pelo painel.
- Testes reais (resultados em `docs/cloudflare-email-routing.md`): anexo de 2,14 MB, endereço inexistente, `authserv-id` (`mx.cloudflare.net`), `forward()` depois do `raw`, exceção no handler (falha temporária, Worker descartável `mail-test-scratch`).
- Branch `etapa-2/deploy-ajustes`: exceção no lugar do encaminhamento de reserva (sem `FALLBACK_FORWARD_TO`), `TRUSTED_AUTHSERV_IDS = ["mx.cloudflare.net"]`, SPF pelo `smtp.mailfrom`, script `inbox:list`.
- Limpeza: regras de teste e Worker `mail-test-scratch` apagados pelo painel, secret `FALLBACK_FORWARD_TO` apagado, arquivos locais do teste apagados.
- Na `main`: PR 2b mergeado e deploy (versão `12e4e188`). Mensagem real com `spf`, `dkim` e `dmarc` = `pass`.
- Testes de memória: `.eml` de 16,7 MB e, no pior caso, de 24,75 MiB. Os dois processados na 1ª tentativa, sem erro, tamanhos iguais no R2 e no D1 (`docs/cloudflare-email-routing.md`).
- Branch `etapa-2/fechamento`: registro dos testes de memória e fechamento da etapa.

### Falta

- _(nada da Etapa 2)_. Verificações que continuam abertas, listadas em `docs/cloudflare-email-routing.md`: `Authentication-Results` forjado com o `authserv-id` da Cloudflare (não testável pelo Gmail) e conferir no painel que o Workers Logs não guarda o `mailFrom`.

## Etapa 1: concluída (2026-10-27)

### Feito (2026-10-27)

- Proteção de segredos: `.gitignore`, `.dockerignore`, `.env.example`, `.gitleaks.toml`.
- gitleaks 8.30.1 instalado em `/usr/local/bin` (binário oficial, checksum conferido).
- Hook de pre-commit (lefthook 2.2.1): bloqueio por nome de arquivo, gitleaks nos arquivos staged, Biome. Testado: commit com token falso e com `.env` forçado foram bloqueados.
- Monorepo pnpm 12 com proteções de cadeia de suprimentos (`minimumReleaseAge` 7 dias, `trustPolicy: no-downgrade`, `allowBuilds` vazio, `engineStrict`).
- `packages/shared` com `mailboxAddress` (zod) e 15 testes.
- CI (gitleaks no histórico completo + lint/typecheck/test) e Dependabot.
- Documentação base, `SECURITY.md`, `LICENSE` (AGPL-3.0).
- Primeiro push feito. CI verde nos jobs `secrets` e `quality`.
- GitHub configurado: Secret scanning, Push protection, Private vulnerability reporting, Dependabot, ruleset da `main` (checks `quality` e `secrets` obrigatórios, sem force push, sem exclusão) e `GITHUB_TOKEN` só leitura.
- Fluxo de trabalho: mudanças só por branch + PR (PRs #1 a #4).
- Dependabot npm corrigido (PR #3): `lefthook@2.2.2` no `ignore`. As execuções seguintes terminaram com sucesso.
- Verificação final: clone novo pelo GitHub + `pnpm install` instala o hook; lint, typecheck e 15 testes passam; `git status` limpo; gitleaks no histórico completo sem vazamentos.

### Falta

- _(nada da Etapa 1)_

### Próximo passo

Etapa 2. O `docs/etapas/etapa-2.md` já está na pasta, mas ainda não foi commitado. Na próxima sessão: commitar o arquivo numa branch, ler e apresentar o plano da Etapa 2.

### Observações

- `lefthook@2.2.2` foi barrado pelo `trustPolicy` (publicado sem provenance, diferente das versões anteriores). Fixado em 2.2.1. O Dependabot falhou tentando essa versão; agora ela está no `ignore` do `.github/dependabot.yml`. Versões futuras com provenance voltam a ser atualizadas.
- pnpm 12 grava o `pnpm-lock.yaml` em dois documentos YAML. Com isso o dependency graph do GitHub não enxerga as dependências: **Dependabot alerts e security updates não funcionam**, só as atualizações semanais de versão. Compensar revisando os PRs semanais do Dependabot.
- No pnpm 12, o `.npmrc` serve só para credenciais: não existe no repositório e está no `.gitignore`.

## Depois

Ideias que ainda não entraram no roteiro.

- Tail Worker que receba os eventos do `mail-core` e guarde só os campos do nosso `log()`, sem `mailFrom`, `rcptTo` nem URL (os Workers Logs ficam desligados, `docs/decisoes.md`). Precisa de um lugar para guardar (D1 ou R2) e de uma retenção definida.
- Ferramenta de reprocessamento da DLQ: reenviar para a fila os `.eml` do R2 que não têm linha no D1 (DLQ expirada após 14 dias), usando o `customMetadata` do objeto. Tratar como duplicata, pela `dedupeKey`, a cópia que fica em `raw/` quando a fila falha no handler.
- Alerta quando chegar mensagem na DLQ `mail-ingest-dlq`.
- Migrar para o Node 26 (LTS ativa desde 2026-10-28) num PR próprio, antes da Etapa 7: `engines`, servidor e o Dockerfile da Etapa 7 com a mesma versão.
- Códigos de recuperação do 2FA.
- Troca de senha pelo próprio usuário (hoje: `user:reset` pela CLI).
- Verificação de senha vazada (HIBP, por k-anonimato).
- Aviso de login novo por e-mail.
- Regra de rate limit da Cloudflare no `/login` (Etapa 7).
- Retenção do `audit_log` (hoje fica para sempre).
- Limpeza das duplicatas em `dup/` no R2 (hoje ficam para sempre). O reprocessamento acima deve ignorar `dup/`.
- `shellcheck` no CI, para os scripts em `scripts/`.
- Relay interno de envio. Previsto para a Etapa 12, mas sobe antes se o nLogin não tiver cooldown de recuperação (`docs/smtp-servicos.md`):
  - container próprio `mail-relay`, separado do webmail, sem portas publicadas;
  - redes: a do Minecraft, depois a do NodeBB, e uma de saída própria. Nunca a rede do webmail;
  - uma credencial do relay por serviço, com remetente fixo;
  - só o relay guarda o token da Cloudflare;
  - limites por destinatário (ex.: 3 por hora) e por serviço por dia (ex.: nLogin 100, NodeBB 50), deixando sobra da cota de 200 para o webmail;
  - log sem conteúdo: serviço, HMAC-SHA-256 do destinatário com chave guardada só no relay e status.

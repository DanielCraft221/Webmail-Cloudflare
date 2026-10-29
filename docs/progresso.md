# Progresso

Atualizado ao fim de toda sessão: o que foi feito, o que falta e o próximo passo exato.

## Etapa atual: 3 (em andamento)

### Próximo passo

Revisar e mergear o PR 1 (`etapa-3/api`). Depois: `git checkout main && git pull --ff-only`, criar o branch `etapa-3/deploy` e seguir o roteiro do PR 2 em `docs/cloudflare.md` (seção 8), um passo de cada vez, com "ok" antes de cada mudança na Cloudflare.

### Feito (2026-10-29)

- Tarefa 8, primeira investigação: a configuração no ar está certa (`logs.enabled`, `persist`, amostragem 100%, `invocation_logs: false`, lida pela API). O token não tem *Workers Observability*, então não deu para consultar os logs guardados. A causa provável é a visão do painel: sem *invocation logs*, a visão "Invocations" fica vazia. Daniel vai tentar a visão **Events** com o filtro `event` = `queued`.
- Pesquisa da tarefa 1 em `docs/cloudflare-api.md`.
- PR 1 (`etapa-3/api`):
  - migração `0002` (`users`, `user_mailboxes`, índice de paginação) e seed `0002_daniel.sql`;
  - middleware: JWT do Access estrito, bearer em tempo constante, usuário ativo, rate limit de 100/min por usuário;
  - as 7 rotas e 108 testes no mail-core;
  - `docs/api.md`, decisões e inventário de segredos.

### Falta

- PR 1: revisão e merge.
- PR 2 (`etapa-3/deploy`): segredos, domínio `mail-api.survivus.com.br`, Access, `vars` no `wrangler.jsonc`, migração e seed remotos, deploy e testes reais com `curl` (tarefa 7).
- **Verificação pendente (tarefa 8):** controle positivo nos Workers Logs. Achar o `queued` na visão Events do painel e, com ele aparecendo, procurar o endereço completo de um remetente de teste, que não pode aparecer. Se a visão Events também não mostrar, registrar aqui e decidir como seguir. O token não muda.

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

- Ferramenta de reprocessamento da DLQ: reenviar para a fila os `.eml` do R2 que não têm linha no D1 (DLQ expirada após 14 dias), usando o `customMetadata` do objeto. Tratar como duplicata, pela `dedupeKey`, a cópia que fica em `raw/` quando a fila falha no handler.
- Alerta quando chegar mensagem na DLQ `mail-ingest-dlq`.
- Limpeza das duplicatas em `dup/` no R2 (hoje ficam para sempre). O reprocessamento acima deve ignorar `dup/`.

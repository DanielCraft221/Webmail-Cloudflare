# Progresso

Atualizado ao fim de toda sessão: o que foi feito, o que falta e o próximo passo exato.

## Etapa atual: 2 (em andamento)

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
- Branch `etapa-2/deploy-ajustes`: exceção no lugar do encaminhamento de reserva (sem `FALLBACK_FORWARD_TO`), `TRUSTED_AUTHSERV_IDS = ["mx.cloudflare.net"]`, SPF pelo `smtp.mailfrom`.

### Falta

- Limpeza: regras `teste-forward@` e `teste-excecao@` no painel, `wrangler delete mail-test-scratch`, `wrangler secret delete FALLBACK_FORWARD_TO` no `mail-core`.
- PR `etapa-2/deploy-ajustes`, merge e novo deploy a partir da `main`.
- Conferir no painel que o Workers Logs não guarda o `mailFrom`.
- `inbox:list` (tarefa 8 da Etapa 2) e teste de memória perto de 25 MiB.

### Próximo passo

Fazer a limpeza acima e abrir o PR do `etapa-2/deploy-ajustes`. Depois do merge: `git pull --ff-only` na `main` e mostrar o comando do deploy.


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

- Ferramenta de reprocessamento: reenviar para a fila os `.eml` do R2 que não têm linha no D1 (DLQ expirada após 14 dias), usando o `customMetadata` do objeto.
- Alerta quando chegar mensagem na DLQ `mail-ingest-dlq`.
- Limpeza das duplicatas em `dup/` no R2 (hoje ficam para sempre). O reprocessamento acima deve ignorar `dup/`.

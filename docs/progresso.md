# Progresso

Atualizado ao fim de toda sessão: o que foi feito, o que falta e o próximo passo exato.

## Etapa atual: 2 (não iniciada)

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

- _(vazio)_

# Progresso

Atualizado ao fim de toda sessão: o que foi feito, o que falta e o próximo passo exato.

## Etapa atual: 1 (concluída, aguardando validação do Daniel)

### Feito (2026-10-27)

- Proteção de segredos: `.gitignore`, `.dockerignore`, `.env.example`, `.gitleaks.toml`.
- gitleaks 8.30.1 instalado em `/usr/local/bin` (binário oficial, checksum conferido).
- Hook de pre-commit (lefthook 2.2.1): bloqueio por nome de arquivo, gitleaks nos arquivos staged, Biome. Testado: commit com token falso e com `.env` forçado foram bloqueados.
- Monorepo pnpm 12 com proteções de cadeia de suprimentos (`minimumReleaseAge` 7 dias, `trustPolicy: no-downgrade`, `allowBuilds` vazio, `engineStrict`).
- `packages/shared` com `mailboxAddress` (zod) e 15 testes.
- CI (gitleaks no histórico completo + lint/typecheck/test) e Dependabot.
- Documentação base, `SECURITY.md`, `LICENSE` (AGPL-3.0).
- Primeiro push feito. CI verde nos jobs `secrets` e `quality`.

### Falta

- Ver o log da execução do Dependabot (npm) que falhou: https://github.com/DanielCraft221/Webmail-Cloudflare/actions/runs/40517091368. Suspeita: `trustPolicy` barrando `lefthook@2.2.2`.
- Configurações manuais no GitHub (Secret scanning, Push protection, proteção da `main`, permissões do `GITHUB_TOKEN`).
- Validação dos critérios de pronto pelo Daniel.

### Próximo passo

Validar a Etapa 1. Depois: ler `docs/etapas/etapa-2.md` e apresentar o plano da Etapa 2.

### Observações

- `lefthook@2.2.2` foi barrado pelo `trustPolicy` (publicado sem provenance, diferente das versões anteriores). Fixado em 2.2.1. Rever quando sair uma versão nova com provenance.
- pnpm 12 grava o `pnpm-lock.yaml` em dois documentos YAML. Com isso o dependency graph do GitHub não enxerga as dependências: **Dependabot alerts e security updates não funcionam**, só as atualizações semanais de versão. Compensar revisando os PRs semanais do Dependabot.
- No pnpm 12, o `.npmrc` serve só para credenciais: não existe no repositório e está no `.gitignore`.

## Depois

Ideias que ainda não entraram no roteiro.

- _(vazio)_

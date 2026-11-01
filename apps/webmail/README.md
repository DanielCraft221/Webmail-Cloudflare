# webmail

Interface web acessada pelo navegador em `webmail.survivus.com.br`. SvelteKit 3 + `adapter-node`.

Nunca acessa D1/R2 diretamente: fala só com a API do `mail-core` (`docs/api.md`). Localmente guarda apenas sessões, limites, bans e cadastros de 2FA em andamento (`node:sqlite`, descartável).

- **Login** (Etapa 5): usuário + senha (argon2id) + 2FA TOTP, sessões, rate limit e IP ban (`docs/webmail-auth.md`). CLI de administração: `pnpm admin` (`docs/admin-cli.md`).
- **Leitura** (Etapa 6), **container** (Etapa 7), **envio e resposta** (Etapa 8), **painel `/admin`** (Etapa 10): ainda por fazer.

## Comandos

```bash
# Desenvolvimento, só em 127.0.0.1:5173 (acesso pelo túnel SSH):
(set -a; . ~/.config/webmail/webmail.env; set +a; pnpm --filter @webmail/webmail dev)

pnpm --filter @webmail/webmail test        # unitários + HTTP contra o build (Worker falso)
pnpm --filter @webmail/webmail test:browser  # Firefox: só na CI
ORIGIN=https://webmail.survivus.com.br pnpm --filter @webmail/webmail build   # Etapa 7
```

Variáveis: `.env.example`.

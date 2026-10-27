# webmail

Interface web acessada pelo navegador em `webmail.survivus.com.br`. **Ainda sem código.**

Vai conter:

- **Login** (Etapa 5): usuário + senha (argon2id) + 2FA TOTP obrigatório, sessões, rate limit, IP ban e a CLI de administração (`pnpm admin ...`).
- **Leitura** (Etapa 6): caixas, lista e leitura de mensagens com HTML sanitizado (DOMPurify) em `<iframe sandbox>`.
- **Container** (Etapa 7): Docker Compose com cloudflared, sem portas publicadas.
- **Envio e resposta** (Etapa 8).
- **Painel de administração** em `/admin` (Etapa 10).

Nunca acessa D1/R2 diretamente: fala só com a API do `mail-core`. Localmente guarda apenas sessões, rate limit e bans (SQLite, descartável).

Stack prevista: SvelteKit + `adapter-node`, `better-sqlite3`.

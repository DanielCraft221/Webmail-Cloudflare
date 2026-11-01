# CLI de administração (`pnpm admin`)

Administra os usuários do webmail. Roda no servidor, da raiz do repositório. Código: `apps/webmail/src/lib/server/cli/`.

- **Usuários, senhas e 2FA** ficam no D1: a CLI fala com as rotas `/v1/admin/*` da API (`docs/api.md`), com o `ADMIN_API_TOKEN`.
- **Sessões, bans e bloqueios** ficam no SQLite local do webmail: a CLI abre o mesmo arquivo (`WEBMAIL_DB_PATH`, padrão `~/.local/share/webmail/webmail.db`). Na Etapa 7 o SQLite fica dentro do container, e o jeito de rodar a CLI lá fica para essa etapa.
- **Toda ação vai para o `audit_log`**, com origem `cli`. As ações locais (sessões, bans, bloqueios) vão por `POST /v1/admin/audit`.

## Configuração: `~/.config/webmail/admin.env`

Criado no PR 2 da Etapa 5 (`docs/cloudflare.md`, seção 9.1). A CLI lê o arquivo (nunca o executa) e **se recusa a rodar** se a permissão não for `600` ou se o dono não for quem roda.

| Variável | Obrigatória | O que é |
|---|---|---|
| `ADMIN_API_TOKEN` | sim | Bearer das rotas `/v1/admin/*`. **Nunca** por argumento de linha de comando |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | sim | Service Token do Access |
| `MAIL_API_URL` | não | Padrão `https://mail-api.survivus.com.br` |
| `WEBMAIL_ORIGIN` | não | Base do link de configuração. Padrão `https://webmail.survivus.com.br` |
| `WEBMAIL_DB_PATH` | não | SQLite local do webmail |

Para links que apontam para o servidor de desenvolvimento (tarefa 8), troque só a base, na própria linha: `WEBMAIL_ORIGIN=http://localhost:5173 pnpm admin user:reset danielcraft221`.

## O link de configuração

`user:create` e `user:reset` mostram um link `…/setup/<token>`, **uma única vez**, só na tela. Ele vale 24 horas e uma única configuração.

- É um segredo: quem tem o link define a senha da pessoa. **Mande por um canal seguro**, nunca por e-mail nem por grupo.
- A API recebe só o SHA-256 do token. A CLI não guarda o link em lugar nenhum e não o grava em log.
- Perdeu o link ou ele venceu: rode `user:reset` de novo.

A pessoa abre o link, lê o QR code no aplicativo autenticador, escolhe a senha (12 a 128 caracteres, diferente do username) e confirma um código. O administrador nunca conhece a senha de ninguém.

## Comandos

Tudo o que a CLI imprime passa por um filtro: caracteres de controle e de formatação (sequências ANSI, `\u202e`) aparecem como texto `\u{1b}`, `\u{202e}`. Nada guardado no D1 ou no SQLite consegue mexer no seu terminal.

### Usuários (D1)

```bash
pnpm admin user:create ana --name "Ana" --role user   # mostra o link uma vez
pnpm admin user:list                                   # sem nenhum segredo
pnpm admin user:reset ana          # apaga senha e 2FA, derruba as sessões, mostra um link novo
pnpm admin user:disable ana        # desativa e derruba as sessões
pnpm admin user:enable ana
pnpm admin user:role ana admin
```

`user:list` mostra, por usuário: nome, papel, ativo, se já tem senha, se já tem 2FA e até quando vale o link pendente.

### Sessões (SQLite local)

```bash
pnpm admin sessions:list           # todas, ou: sessions:list ana
pnpm admin sessions:revoke ana     # todas as sessões da Ana
pnpm admin sessions:revoke 3f9a0c1b2d4e   # uma sessão, pelo id de 12 caracteres do sessions:list
```

O id é o começo do SHA-256 do token. Ele não abre sessão nenhuma.

### Bans e bloqueios (SQLite local)

```bash
pnpm admin ban:list
pnpm admin ban:add 203.0.113.7 --hours 48   # padrão 24 h
pnpm admin ban:remove 2001:db8:1:2::5       # IPv6: o ban vale para o /64 inteiro
pnpm admin lock:clear ana                   # libera um username bloqueado por excesso de falhas
```

Regras do webmail (`docs/webmail-auth.md`): 10 falhas de um IP em 15 minutos dão ban de 15 min; os bans seguintes em 7 dias duram 1 h e depois 24 h. 5 falhas num username em 15 minutos o bloqueiam por 15 min, de qualquer IP.

### Auditoria (D1)

```bash
pnpm admin audit:list              # últimos 50
pnpm admin audit:list --limit 200  # até 500
```

Mostra quando, origem (`cli` ou `webmail`), ação, usuário, alvo, IP e detalhe. Tentativas com username inexistente aparecem sem o username digitado.

## Erros comuns

| Mensagem | Causa |
|---|---|
| `… must have permission 600` | `chmod 600 ~/.config/webmail/admin.env` |
| `API answered 401` | `ADMIN_API_TOKEN` ou Service Token errado ou vencido |
| `User not found` | O username não existe (`user:list`) |
| `Username already exists` | `user:create` com um username repetido |

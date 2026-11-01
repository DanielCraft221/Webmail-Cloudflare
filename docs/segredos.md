# Segredos

Este documento lista **onde** cada segredo vive. **Nunca** coloque valores aqui.

## Onde vive cada segredo

| Segredo                                         | Onde vive                                                                                 | Nunca                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Secrets do Worker (tokens da API interna, etc.) | `wrangler secret put`                                                                     | Em `wrangler.toml` ou em qualquer arquivo commitado                         |
| Desenvolvimento local do Worker                 | `apps/mail-core/.dev.vars`                                                                | Commitado                                                                   |
| Config do webmail em produção                   | `/srv/webmail/.env` no servidor, dono `root`, `chmod 600`, lido via `env_file` do compose | Dentro do repositório, dentro da imagem Docker, em pasta servida pelo Nginx |
| Token do Cloudflare Tunnel                      | `/srv/cloudflared/.env`, `chmod 600`                                                      | Em compose commitado ou em linha de comando visível no `ps`                 |
| Token da Cloudflare para Wrangler (deploy)      | Variável de ambiente da sessão ou arquivo `chmod 600` fora do repositório                 | Em `.bashrc` compartilhado ou commitado                                     |
| Token SMTP do nLogin                            | Config do nLogin no servidor Minecraft, arquivo legível só pelo usuário do servidor       | Reaproveitado; em print de tela, log ou backup público                      |
| Token SMTP do NodeBB                            | Painel admin do NodeBB (fica no banco do NodeBB)                                          | Reaproveitado; em print de tela ou dump de banco compartilhado              |

## Inventário

Atualize a cada segredo criado ou rotacionado. **Sem valores.**

| Nome | Local | Quem usa | Permissões | Última rotação |
| ---- | ----- | -------- | ---------- | -------------- |
| Token do Wrangler (Account API Token) | `~/.config/cloudflare/wrangler.env` no servidor, `chmod 600`, fora do repositório | Wrangler neste servidor (deploy, D1, R2, filas, logs) | Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Queues Edit, Workers Tail Read, User Details Read. Nenhuma permissão de zona | Criado em 2026-10-28, expira em 2026-11-30 |
| `INTERNAL_API_TOKEN` | `wrangler secret` do `mail-core` e `~/.config/webmail/api.env` no servidor (`chmod 600`), base do `.env` do webmail na Etapa 7 | Webmail → API do `mail-core` (bearer) | Lê e altera as caixas permitidas a cada usuário, sempre com o Service Token junto | Criado no PR 2 da Etapa 3 |
| Service Token `webmail` do Access (Client ID e Client Secret) | `~/.config/webmail/api.env` no servidor (`chmod 600`). O Client ID também como `wrangler secret` `ACCESS_CLIENT_ID` | Webmail → Cloudflare Access na frente de `mail-api.survivus.com.br` | Passa só pela política "Service Auth" dessa aplicação | Criado no PR 2 da Etapa 3 (fim de outubro de 2026), duração de 1 ano: expira no fim de outubro de 2027. Data exata em Zero Trust › Service Tokens. Renovar antes, senão o webmail perde o acesso à API |
| `ACCESS_AUD` (AUD tag da aplicação `mail-api` do Access) | `wrangler secret` do `mail-core` e `~/.config/webmail/api.env` | Worker, para conferir o `aud` do JWT do Access | Nenhuma: não é segredo de verdade (o Access o devolve no cabeçalho `cf-access-aud`). É secret só para ficar fora do repositório sem exceção no gitleaks | Criado no PR 2 da Etapa 3. Muda só se a aplicação for recriada |
| `ADMIN_API_TOKEN` | `wrangler secret` do `mail-core` e `~/.config/webmail/admin.env` no servidor (`chmod 600`). **Nunca no `webmail.env` nem no `.env` do webmail** | CLI de administração (`pnpm admin`) → `/v1/admin/*` | Cria, reseta, desativa e muda o papel de usuários; lê o `audit_log`. Não abre caixas nem mensagens. Vazou: rotacionar na hora (`wrangler secret put` + `admin.env`) e conferir `audit:list` | Criado em 2026-11-01 (PR 2 da Etapa 5), `docs/cloudflare.md` seção 9 |
| `TOTP_ENCRYPTION_KEY` | `~/.config/webmail/webmail.env` (`chmod 600`); na Etapa 7, `/srv/webmail/.env`. **Só o webmail.** Nunca no Worker nem no D1 | Webmail, para cifrar e decifrar os segredos TOTP (AES-256-GCM) | Vazou junto com o D1: quem tem os dois gera códigos de todos (ainda precisa da senha). Perdida: nenhum e-mail se perde, mas todos refazem o 2FA (`user:reset`). **Gerada uma vez; não gerar outra sem motivo** | Criada em 2026-11-01 (PR 2 da Etapa 5), `docs/cloudflare.md` seção 9.1 |

Tokens temporários já revogados (histórico, para conferir com a lista de tokens no painel):

| Nome | Uso | Permissões | Criado | Revogado |
| ---- | --- | ---------- | ------ | -------- |
| `logs-check` | Consultar os Workers Logs guardados (tarefa 8 da Etapa 3) | Workers Observability Read | 2026-10-29 | 2026-10-30. Arquivo `~/.config/cloudflare/logs-check.env` apagado |
| `smtp-teste` | Testes de envio da Etapa 4 | Email Sending: Edit | 2026-10-30 (validade até 2026-11-07, deveria ser 1 dia) | 2026-10-31. SMTP `535` e API `Invalid API Token` conferidos |
| `smtp-teste-2` | Teste do domínio principal e dos cabeçalhos (Etapa 4) | Email Sending: Edit | 2026-10-31 | 2026-10-31. SMTP `535` e API `Invalid API Token` conferidos. Arquivo `~/.config/cloudflare/smtp-teste.env` apagado |

Hoje não existe nenhum token com *Email Sending: Edit*. Os tokens `smtp-nlogin` e `smtp-nodebb` só são criados na hora de configurar cada serviço (`docs/smtp-servicos.md`).

Tokens SMTP: rotação a cada 6 meses, ou na hora em caso de suspeita.

## Gerar um segredo forte

```sh
openssl rand -base64 32
```

Gere direto no terminal e cole direto no destino (`wrangler secret put`, arquivo `.env` do servidor). Nunca num chat, bloco de notas ou mensagem.

## Criar um arquivo de segredo com a permissão correta

Crie o arquivo **já** com permissão 600, antes de escrever qualquer coisa nele:

```sh
sudo install -m 600 -o root -g root /dev/null /srv/webmail/.env
sudo nano /srv/webmail/.env
```

Criar o arquivo e só depois rodar `chmod` deixa uma janela em que ele fica legível por outros usuários.

## Se um segredo vazar

1. **Revogue primeiro.** Apague ou rotacione o token no painel da Cloudflare (ou onde ele foi emitido) imediatamente.
2. Crie um novo e configure no serviço.
3. **Depois** investigue: como vazou, se foi usado (logs de entrega do Email Sending, relatórios DMARC, logs do Worker).
4. Registre a rotação no inventário acima.

**Apagar o segredo do histórico do git não resolve.** Num repositório público, ele já foi copiado por robôs que varrem o GitHub em minutos. O segredo é público a partir do push: só a revogação o torna inútil.

## Regra para os outros sites no Nginx

Os outros sites do servidor (rede `sites`) seguem estas regras:

- Bloquear arquivos ocultos em todo `server`:

  ```nginx
  location ~ /\. { deny all; }
  ```

- Manter `.env` e qualquer arquivo de configuração **fora** da pasta pública (`root`). O bloqueio acima só serve de reserva, caso um desses arquivos vá parar na pasta pública por engano.

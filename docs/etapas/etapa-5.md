# Etapa 5: Webmail: login, 2FA, sessões, rate limit, IP ban e CLI de administração

> **Pré-requisito:** Etapa 4 concluída e mergeada (`docs/progresso.md` aponta a Etapa 5).
> As regras permanentes estão em `CLAUDE.md`. Siga-as durante toda a etapa.
> **Esta é a etapa com mais código de segurança até agora.** Na dúvida, escolha o mais simples e o mais fechado, e me pergunte.

## Objetivo

Criar o `apps/webmail` (SvelteKit + `adapter-node`) com **login por usuário + senha (argon2id) + código TOTP obrigatório**, sessões, rate limit e IP ban, e a **CLI de administração** (`pnpm admin ...`) para criar e gerenciar usuários. No fim, eu tenho a minha conta real, com 2FA no meu celular, e entro no webmail rodando no servidor.

**Fora desta etapa:** caixas e leitura de mensagens (Etapa 6), Docker e Tunnel (Etapa 7), envio (Etapa 8), permissões por caixa (Etapa 9), painel `/admin` (Etapa 10).

## Antes de começar

1. Na `main`, rode `git pull --ff-only` e confirme que o `git status` está limpo.
2. Crie o branch `etapa-5/worker` e mova este arquivo para `docs/etapas/etapa-5.md` nele.
3. Faça a pesquisa da tarefa 1.
4. Apresente o plano em tópicos curtos e **espere minha aprovação**.

## Fluxo: três PRs

- **PR 1, Worker (`etapa-5/worker`):** pesquisa, migração `0003`, rotas de autenticação, de administração e de auditoria, testes e `docs/api.md`. **Nenhuma mudança na Cloudflare.**
- **PR 2, implantação do Worker (`etapa-5/worker-deploy`, a partir da `main` com o PR 1):** segredo novo, migração remota e deploy. Cada passo na Cloudflare: mostre e espere meu "ok".
- **PR 3, webmail e CLI (`etapa-5/webmail`):** app SvelteKit, CLI, testes unitários e testes no navegador (`webapp-testing`).
- `security-audit` antes de **cada** PR. Deploy só a partir da `main` atualizada e com o `git status` limpo.

## Decisões já tomadas (não reabra sem me perguntar)

**Onde ficam os dados (sem mudar a arquitetura):**
- **Usuários, hash da senha e segredo TOTP ficam no D1**, a fonte da verdade. O SQLite local do webmail guarda só o que é descartável: sessões, rate limit, bans, códigos TOTP já usados e cadastros de 2FA em andamento.
- **Quem verifica a senha e o código é o webmail**, não o Worker. O argon2id com parâmetros decentes não cabe no limite de CPU do Worker. O webmail busca o hash na API interna e verifica localmente.
- **O segredo TOTP é guardado cifrado** (AES-256-GCM) com a chave `TOTP_ENCRYPTION_KEY`, que **só o webmail conhece**. O ID do usuário entra como dado associado (AAD), então trocar o segredo de um usuário pelo de outro no D1 não funciona. Quem ler o D1 não consegue gerar códigos.
- **Perder a `TOTP_ENCRYPTION_KEY` não perde e-mail**: só obriga a refazer o 2FA de todos pela CLI. Ela é gerada uma vez nesta etapa e vai para o `/srv/webmail/.env` na Etapa 7. **Não gere outra.**

**Login:**
- **Um formulário só**, com usuário, senha e código. Se qualquer um estiver errado, a mensagem é sempre a mesma: "Usuário, senha ou código inválidos". Assim o atacante nunca descobre se acertou a senha.
- **Usuário inexistente custa o mesmo tempo**: o webmail verifica a senha contra um hash falso, gerado na inicialização com os mesmos parâmetros.
- **Sem cadastro público.** Usuário só nasce pela CLI.
- **Primeiro acesso por link de configuração:** a CLI gera um link de uso único, válido por 24 horas. A pessoa abre o link, define a própria senha, lê o QR code no aplicativo autenticador e confirma um código. **O administrador nunca conhece a senha de ninguém.** O D1 guarda só o hash (SHA-256) do token do link.
- **Sem códigos de recuperação nesta etapa.** Perdeu o celular → o administrador reseta pela CLI. Com 4 pessoas, é mais simples e é um segredo a menos. Vai para "Depois".
- **Troca de senha pelo próprio usuário:** fica para "Depois". Nesta etapa, quem troca é a CLI (reset → novo link).

**Separação de credenciais na API:**
- As rotas de administração do Worker (`/v1/admin/*`) exigem um **bearer próprio, `ADMIN_API_TOKEN`**, diferente do `INTERNAL_API_TOKEN`. O Access continua igual (o mesmo Service Token).
- **O webmail nunca recebe o `ADMIN_API_TOKEN`.** Só a CLI usa esse token. Se o webmail for comprometido, o atacante não consegue criar um usuário novo para manter acesso nem resetar o 2FA de ninguém.
- O `INTERNAL_API_TOKEN` não abre `/v1/admin/*`, e o `ADMIN_API_TOKEN` não abre as outras rotas. Os dois casos têm teste.

**Desenvolvimento:**
- O servidor de desenvolvimento escuta **só em `127.0.0.1`**. Nunca `--host`, nunca `0.0.0.0`. Eu acesso pelo túnel SSH do Termius (encaminhamento de porta local).
- **Os segredos de desenvolvimento ficam fora do repositório**, em `~/.config/webmail/` (`chmod 600`), e são carregados só na sessão que roda o `pnpm dev`. Nada de `.env` com valor real dentro do repositório, nem ignorado.
- **Testes automáticos nunca usam a API real nem segredos reais.** Eles usam um Worker falso que segue o contrato do `docs/api.md`, validado com os schemas `zod` de `packages/shared`.

## Tarefas

### 1. Pesquisa (PR 1, antes do código)

Confira na documentação atual e registre em `docs/webmail-auth.md`, com links:

- **SvelteKit** atual e o `adapter-node`: as variáveis `ORIGIN`, `ADDRESS_HEADER` e `XFF_DEPTH`, a proteção de CSRF por origem das *form actions* (nome e padrão da opção na versão atual) e a configuração de **CSP** (`kit.csp`, com nonce ou hash).
- **argon2id:** parâmetros mínimos recomendados pela OWASP hoje e o custo real em memória e tempo no nosso servidor. Proposta inicial: 64 MiB, 3 iterações, paralelismo 1. Meça.
- **TOTP (RFC 6238):** compatibilidade com Google Authenticator, Aegis e 2FAS (SHA-1, 6 dígitos, 30 segundos) e a janela de tolerância usual.
- **Cookies `__Host-` com `Secure` em `http://localhost`**: se Chrome e Firefox aceitam no desenvolvimento pelo túnel SSH. Se não aceitarem, proponha a alternativa **sem enfraquecer a produção**.
- **Versão LTS do Node** atual. A Etapa 7 vai usar a mesma no Dockerfile.

### 2. Banco de dados (PR 1: migração `0003`)

Na tabela `users` (criada na Etapa 3):
- `password_hash` (texto, pode ser nulo), `totp_secret_enc` (texto, pode ser nulo), `setup_token_hash` (texto único, pode ser nulo), `setup_expires_at`, `updated_at`.
- **Usuário sem `password_hash` ou sem `totp_secret_enc` nunca consegue entrar**, mesmo ativo. O seed `daniel` da Etapa 3 fica nesse estado até eu usar o link de configuração.

Tabela nova `audit_log`: id, data (UTC), `actor_user_id` (pode ser nulo), ação, alvo, IP, detalhe em JSON curto. Índice por data.

### 3. Rotas novas do Worker (PR 1)

Mantêm o JWT do Access e o bearer em tempo constante. Mudam só o token aceito e a exigência do `X-Webmail-User`.

| Rota | Token | O que faz |
|---|---|---|
| `POST /v1/auth/lookup` `{username}` | interno | Devolve id, ativo, `password_hash`, `totp_secret_enc` e papel. Usuário inexistente → 404 genérico. Username no corpo, nunca na URL |
| `POST /v1/auth/setup/lookup` `{tokenHash}` | interno | Confere se o link é válido e não expirou. Devolve só id e username |
| `POST /v1/auth/setup/complete` `{tokenHash, passwordHash, totpSecretEnc}` | interno | Grava a senha e o segredo e **invalida o link**, numa única operação condicional (link válido e não expirado). Link usado ou expirado → 404 |
| `GET /v1/me` | interno + `X-Webmail-User` | id, username, nome de exibição e papel. O webmail usa para revalidar a sessão |
| `POST /v1/audit` | interno | Grava um evento de login, logout, ban ou configuração |
| `POST /v1/admin/users` | admin | Cria um usuário com o hash do token do link (a CLI gera o token) |
| `GET /v1/admin/users` | admin | Lista os usuários **sem** hash, segredo ou token |
| `POST /v1/admin/users/:id/reset` | admin | Apaga a senha e o segredo TOTP, grava um novo hash de link |
| `PATCH /v1/admin/users/:id` | admin | `active`, `role`, `display_name` |
| `GET /v1/admin/audit?limit=` | admin | Últimos eventos |

- Toda rota de administração grava no `audit_log`.
- Nenhuma resposta, log ou erro contém hash de senha, segredo TOTP, token de link ou cabeçalho `Authorization`, com exceção do `auth/lookup`, que existe para isso.
- Atualize o `docs/api.md` com o contrato de cada rota.

### 4. Webmail (PR 3)

**Páginas:** `/login`, `/logout` (só POST), `/setup/[token]`, `/` (provisória: "Conectado como X" e o botão Sair) e um rodapé com o **link para o código-fonte** (AGPL). Interface em português.

**Senha:** argon2id com os parâmetros medidos na pesquisa. Mínimo de 12 caracteres e máximo de 128, sem regra de composição, diferente do username. **No máximo 2 verificações de argon2 ao mesmo tempo.** Além disso → 503, para um ataque não esgotar a memória do container.

**TOTP:**
- Janela de ±1 passo (30 s).
- **O código usado não vale de novo:** guardar o último passo aceito por usuário no SQLite local.
- **QR code gerado no próprio servidor** (imagem `data:`). **Nunca** usar serviço externo de QR, porque o segredo iria junto na URL.
- O segredo também aparece em texto, para digitar à mão. Nunca vai para log.
- No cadastro, o segredo fica em andamento no SQLite local por até 10 minutos e só vai para o D1 depois que a pessoa confirmar um código válido.

**Sessões:**
- Token aleatório de 32 bytes no cookie `__Host-webmail_session` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`). O SQLite guarda **só o SHA-256 do token**, nunca o token.
- Expira após 2 h sem uso e 12 h no total. Um token novo a cada login. No máximo 10 sessões por usuário: a mais antiga cai.
- Revalidação com `GET /v1/me` no máximo a cada 5 minutos. **Se a API responder 401 para o usuário da sessão** (usuário desativado), a sessão é apagada na hora.

**Rate limit e IP ban (SQLite local):**
- **Ban checado primeiro**, antes de ler o corpo e antes do argon2.
- Por IP: 10 falhas em 15 minutos → ban de 15 min. Bans seguintes em 7 dias: 1 h, depois 24 h.
- **IPv6 conta pelo bloco `/64`**, porque um atacante troca de endereço dentro do próprio bloco.
- Por username: 5 falhas em 15 minutos → esse username fica bloqueado por 15 min, de qualquer IP, com a mesma mensagem genérica e sem rodar o argon2. A CLI libera.
- A página `/setup/[token]` tem rate limit por IP.

**IP real:**
- Em produção, o IP vem do `CF-Connecting-IP`.
- **Se o cabeçalho faltar ou for inválido em produção → 400.** Nunca usar o IP do cloudflared: senão um ban derrubaria todo mundo.
- Em produção (`NODE_ENV=production`), o app **não sobe** se a configuração não estiver confiando no `CF-Connecting-IP`. No desenvolvimento, usa o IP do socket.

**Cabeçalhos:** CSP restrita (`default-src 'self'`, `img-src 'self' data:`, `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'none'`, `object-src 'none'`), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` fechada, `Cache-Control: no-store` nas páginas logadas, `ORIGIN` explícito, proteção de CSRF do SvelteKit ligada. Em produção, também `Strict-Transport-Security`.

**Auditoria:** login com sucesso ou falha (com o motivo interno, que nunca aparece para o usuário), ban, desban, configuração concluída e logout vão para o `POST /v1/audit`. **Tentativa com username inexistente não grava o username digitado**: as pessoas às vezes digitam a senha no campo do usuário.

**Logs:** nunca senha, código TOTP, token de link, token de sessão, cookie, `Authorization` ou conteúdo de `.env`. Isso tem teste.

### 5. CLI de administração (PR 3)

`pnpm admin <comando>`, rodando no servidor:

| Comando | O que faz |
|---|---|
| `user:create <username> [--role admin\|user] [--name "..."]` | Cria o usuário e mostra **uma única vez** o link de configuração (24 h) |
| `user:list` | Lista os usuários, sem nenhum segredo |
| `user:reset <username>` | Apaga a senha e o 2FA, derruba as sessões e mostra um novo link |
| `user:disable <username>` / `user:enable <username>` | Desativa ou reativa. Desativar derruba as sessões |
| `user:role <username> <admin\|user>` | Muda o papel |
| `sessions:list [username]` / `sessions:revoke <username\|id>` | Sessões locais |
| `ban:list` / `ban:remove <ip>` / `ban:add <ip> [--hours N]` | Bans locais |
| `lock:clear <username>` | Libera um username bloqueado por excesso de falhas |
| `audit:list [--limit N]` | Últimos eventos do D1 |

- A CLI lê o `ADMIN_API_TOKEN` e o Service Token de `~/.config/webmail/admin.env` (`chmod 600`). **Nunca por argumento de linha de comando.** Se a permissão do arquivo não for `600`, ela se recusa a rodar.
- Toda ação da CLI vai para o `audit_log`, com o ator `cli`.
- O link mostrado pela CLI é um segredo de 24 h. **Eu mando para a pessoa por um canal seguro.** Nunca vai para log, nem para o histórico do shell.

### 6. Testes (PR 1 e PR 3)

Casos obrigatórios, além dos que você achar necessários:

| Caso | Esperado |
|---|---|
| `INTERNAL_API_TOKEN` em `/v1/admin/*` / `ADMIN_API_TOKEN` nas outras rotas | 401 nos dois |
| `setup/complete` com link usado, expirado ou inexistente | 404 |
| Duas chamadas simultâneas de `setup/complete` com o mesmo link | Só uma grava |
| `admin/users` e `admin/audit` | Sem hash, segredo ou token na resposta |
| Usuário ativo sem senha ou sem 2FA | Não entra |
| Senha certa e código errado / senha errada e código certo / usuário inexistente | A **mesma** resposta |
| Código TOTP já usado | Recusado |
| Código do passo anterior e do seguinte | Aceitos; dois passos de distância, recusado |
| Segredo cifrado de outro usuário colado no D1 | Falha ao decifrar (AAD), login recusado |
| 10 falhas de um IP | Ban; o próximo ban dura mais |
| Dois IPv6 do mesmo `/64` | Contam juntos |
| 5 falhas num username | Bloqueado de outro IP também |
| Ban ativo | Recusado **sem** rodar o argon2 |
| Produção sem `CF-Connecting-IP` | 400 |
| Produção sem confiar no `CF-Connecting-IP` | O app não sobe |
| Cookie de sessão | `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`; o SQLite tem só o hash |
| Sessão ociosa por 2 h / com 12 h de vida | Expirada |
| `GET /v1/me` com 401 | Sessão apagada |
| POST de outra origem | Recusado (CSRF) |
| Cabeçalhos de segurança | Presentes em todas as páginas |
| Logs durante login, configuração e erro (com senha e código conhecidos) | Nenhum dos dois aparece |
| CLI com `admin.env` diferente de `600` | Recusa |

**No navegador (`webapp-testing`), contra o Worker falso:** configuração pelo link, login, código errado, ban depois de 10 falhas e logout.

### 7. Implantação do Worker (PR 2; cada passo na Cloudflare: mostre e espere meu "ok")

1. **Segredos gerados por mim**, nunca por você nem no chat:
   Comando com proteção contra rodar duas vezes em `docs/cloudflare.md`, seção 9.1. **Nunca use `install -m 600 /dev/null` solto sobre arquivos que já existem:** ele os zera e gera uma `TOTP_ENCRYPTION_KEY` nova.
   - `admin.env`: `ADMIN_API_TOKEN` (`openssl rand -base64 48`), mais o Client ID e o Client Secret do Service Token (copiados do `api.env`).
   - `webmail.env`: o que o webmail precisa (`INTERNAL_API_TOKEN`, o Service Token e a `TOTP_ENCRYPTION_KEY`, com `openssl rand -base64 32`). **Sem o `ADMIN_API_TOKEN`.**
   - Me passe comandos que gravem o valor no arquivo **sem mostrar na tela**, e o `wrangler secret put ADMIN_API_TOKEN` lendo da entrada padrão.
2. Migração `0003` no D1 remoto.
3. Deploy a partir da `main` limpa.
4. Testes com `curl` (eu rodo): o token interno em `/v1/admin/users` → 401; o token de admin → lista sem segredos; o token de admin em `/v1/mailboxes` → 401.

### 8. Minha conta real (depois do merge do PR 3)

1. Você me passa o comando para subir o `pnpm dev` carregando o `webmail.env` só naquela sessão, escutando em `127.0.0.1`.
2. No Termius, eu crio o encaminhamento de porta local para o servidor.
3. `pnpm admin user:reset daniel` (mexe no D1 de produção: mostre e espere meu "ok").
4. Eu abro o link, defino a senha e cadastro o 2FA no meu celular.
5. Eu testo: login certo, código errado, um código repetido e o logout.
6. `pnpm admin audit:list` mostra esses eventos.

### 9. Documentação

- `docs/webmail-auth.md`: pesquisa, parâmetros escolhidos e fluxos de login, configuração e reset.
- `docs/api.md`: rotas novas.
- `docs/admin-cli.md`: cada comando, com exemplo.
- `docs/decisoes.md`: verificação no webmail, segredo cifrado com AAD, token de admin separado, formulário único, sem códigos de recuperação.
- `docs/segredos.md`: `ADMIN_API_TOKEN` e `TOTP_ENCRYPTION_KEY` (onde estão, quem usa, o que acontece se vazarem ou se perderem), sem valores.
- `.env.example` do webmail: todas as variáveis com valor falso e comentário. **Sem `ADMIN_API_TOKEN`.**
- `CLAUDE.md`: seção "Comandos" (`pnpm admin`, `pnpm dev` do webmail).
- `docs/progresso.md`: ao fim de cada sessão. No "Depois": códigos de recuperação, troca de senha pelo usuário, verificação de senha vazada (HIBP), aviso de login novo por e-mail, regra de rate limit da Cloudflare no `/login` (Etapa 7) e retenção do `audit_log`.

## Riscos conhecidos (registre em `docs/decisoes.md`)

- **Quem compromete o webmail lê todas as caixas.** A permissão por caixa confia no `X-Webmail-User` que o webmail manda. Isso já valia desde a Etapa 3. O token de admin separado só impede criar usuários e resetar o 2FA.
- **Bloqueio por username permite negar acesso:** um atacante pode manter um username bloqueado. Com 4 usuários e a CLI para liberar, aceito. O ban por IP é a defesa principal.
- **Etapa 7:** a CLI precisa do SQLite de dentro do container (sessões e bans). O jeito de rodá-la lá fica para a Etapa 7.

## Critérios de pronto

| Teste | Esperado |
|---|---|
| Todos os casos da tarefa 6 | Passam no CI |
| Testes com `curl` da tarefa 7 | Resultado esperado |
| Minha conta real (tarefa 8) | Configurada pelo link, 2FA no celular, login e logout funcionando |
| Código TOTP repetido | Recusado no teste real |
| `audit:list` | Mostra os meus eventos, sem nenhum segredo |
| Servidor de desenvolvimento | Escuta só em `127.0.0.1` (`ss -tlnp`) |
| `webmail.env` | Não contém `ADMIN_API_TOKEN` |
| `gitleaks` no histórico | Nenhum vazamento; nenhum arquivo de `~/.config/webmail/` no repositório |
| Dependências | Todas com licença compatível com AGPL, cada uma justificada |
| `docs/progresso.md` | Etapa 5 concluída, próximo passo: Etapa 6 |

## Ao terminar

1. Mostre como eu mesmo testo cada critério, passo a passo.
2. Liste as dependências adicionadas, a licença de cada uma e por que entrou.
3. Diga o que ficou pendente ou arriscado, principalmente o que a pesquisa não confirmou.
4. **Pare.** Não comece a Etapa 6.

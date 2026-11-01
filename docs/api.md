# API interna do `mail-core`

Contrato que o webmail segue (Etapas 5 e 6). A API é usada **só pelo webmail**, de servidor para servidor. O código está em `apps/mail-core/src/api.ts` e os schemas dos pedidos em `packages/shared/src/api.ts` (`import { api } from "@webmail/shared"`).

- **Endereço:** `https://mail-api.survivus.com.br` (ligado no PR 2 da Etapa 3). O `workers.dev` continua desligado.
- **Formato:** JSON em UTF-8, nomes em `camelCase`. Datas em ISO 8601 UTC (`2026-10-28T23:36:20.236Z`).
- **Sem CORS:** nenhuma resposta tem cabeçalho `Access-Control-*`. Um navegador não consegue chamar a API.

## Autenticação: todo pedido em `/v1/*`

Os pedidos levam até **quatro** cabeçalhos:

| Cabeçalho | Valor | Quem confere |
| --- | --- | --- |
| `CF-Access-Client-Id` | Client ID do Service Token `webmail` | Cloudflare Access, na borda |
| `CF-Access-Client-Secret` | Client Secret do Service Token | Cloudflare Access, na borda |
| `Authorization` | `Bearer <token do grupo da rota>` (tabela abaixo) | Worker |
| `X-Webmail-User` | UUID do usuário logado no webmail (só no grupo "usuário") | Worker, no D1 |

**Três grupos de rotas** (Etapa 5). Cada token abre só o próprio grupo:

| Grupo | Rotas | Bearer | `X-Webmail-User` | Rate limit (chave) |
| --- | --- | --- | --- | --- |
| Usuário | caixas, mensagens, busca e `GET /v1/me` | `INTERNAL_API_TOKEN` | obrigatório | o UUID do usuário |
| Serviço | `/v1/auth/*` e `POST /v1/audit` | `INTERNAL_API_TOKEN` | não usado | `service` |
| Administração | `/v1/admin/*` | `ADMIN_API_TOKEN` | não usado | `admin` |

- O `INTERNAL_API_TOKEN` (webmail) **nunca** abre `/v1/admin/*`. O `ADMIN_API_TOKEN` (só a CLI) **não abre** as outras rotas. **O webmail nunca recebe o `ADMIN_API_TOKEN`.**
- O grupo é decidido pelo **padrão da rota casada** no roteador, nunca pelo texto da URL: um `%61dmin` ou uma barra dupla não mudam o grupo. Um caminho que não casa com rota nenhuma cai no grupo "usuário" (o mais fechado) e termina em 404.
- O Service Token do Access é o mesmo nos três grupos.

Sem o Service Token (ou com um falso), o Access barra o pedido antes do Worker com `401` em `text/html` e o cabeçalho `cf-access-domain`. O `401` do Worker é sempre JSON. O webmail deve tratar os dois como falha de configuração, não como sessão expirada do usuário. Com o Service Token, o Access acrescenta o `Cf-Access-Jwt-Assertion`, e o Worker confere, nesta ordem:

1. **JWT do Access:**
   - assinatura RS256 com as chaves de `https://<equipe>.cloudflareaccess.com/cdn-cgi/access/certs`;
   - `iss` exatamente igual ao team domain;
   - `aud` contendo o AUD da aplicação;
   - `exp` obrigatório;
   - `exp` e `nbf` com no máximo 60 s de tolerância de relógio;
   - `common_name` igual ao Client ID esperado.
2. **Bearer** do grupo da rota, comparado em tempo constante.
3. **Usuário** (só no grupo "usuário"): `X-Webmail-User` é um UUID de um usuário existente, ativo e **com senha e 2FA configurados**. Depois de um reset, até a nova configuração, todas as rotas desse grupo respondem `401`.
4. **Rate limit:** 100 pedidos por minuto por chave (aproximado, por local da Cloudflare).

As falhas de 1 a 3 respondem `401 {"error":"unauthorized"}`, sem dizer qual passo falhou. Se faltar qualquer configuração (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_CLIENT_ID`, `INTERNAL_API_TOKEN`, `ADMIN_API_TOKEN`), os pedidos do grupo afetado respondem 401: a API fecha, não abre.

**O `X-Webmail-User` só identifica.** Ele nunca dá permissão: toda rota confere no D1 (`user_mailboxes.can_read`) se esse usuário lê a caixa.

**Caixa desativada continua legível.** `mailboxes.active = 0` só faz o recebimento recusar novos e-mails para o endereço. Quem tem `can_read` na caixa continua vendo as mensagens antigas. Para tirar o acesso, remova a permissão em `user_mailboxes`.

## Medido em produção (2026-10-29)

Testes reais com `curl` depois do deploy (versão `1ddd2b98-76ea-4f7a-b152-f6638efe5417`). Hoje eles rodam em `scripts/smoke-api.sh` (`docs/cloudflare.md`, seção 8.5).

- **Autenticação:**
  - Sem cabeçalho: `401` do Access, em `text/html`.
  - Só o Service Token, Service Token e bearer sem `X-Webmail-User`, ou com um UUID inexistente: `401 {"error":"unauthorized"}` do Worker.
  - Com tudo certo: `200`. O JWT real do Access passou na conferência estrita (assinatura, `iss`, `aud`, `exp` e `common_name`).
- **Respostas:** as respostas JSON vêm com `X-Content-Type-Options: nosniff` e `Cache-Control: no-store`, sem `Access-Control-*`.
- **Anexo de 2.252.089 bytes:**
  - `application/octet-stream`;
  - `attachment; filename="Anexo.png"; filename*=UTF-8''Anexo.png`;
  - `private, no-store`;
  - mesmo tamanho do D1.
  - O tipo declarado (`image/png`) não foi para a resposta.
- **Anexo de 18.962.423 bytes:** baixado inteiro, com o tamanho do D1.
- **`PATCH {"isRead":true}`:** a contagem de não lidas da pasta caiu 1 em `GET /v1/mailboxes`. `{"folder":"sent"}` deu `400`.
- **`workers.dev`:** `404` com `error code: 1042` (desligado).
- **Imagem inline também é anexo:** uma imagem colada no corpo pelo Gmail (`isInline: true`, com `contentId`) aparece em `attachments` e pode ser baixada pela mesma rota. A Etapa 6 usa o `contentId` para mostrá-la no HTML.

## Erros

| Status | Corpo | Quando |
| --- | --- | --- |
| 400 | `{"error":"bad_request"}` | Parâmetro ou corpo inválido (campo a mais também é inválido) |
| 401 | `{"error":"unauthorized"}` | Autenticação (acima) |
| 404 | `{"error":"not_found"}` | Recurso inexistente, ID malformado **ou sem permissão**. As três respostas são idênticas |
| 409 | `{"error":"conflict"}` | `POST /v1/admin/users` com username já existente |
| 429 | `{"error":"rate_limited"}` | Rate limit |
| 500 | `{"error":"internal_error"}` | Erro interno. Nunca traz detalhe nem stack trace |

Todas as respostas têm `X-Content-Type-Options: nosniff` e `Cache-Control: no-store` (downloads: `private, no-store`). Qualquer caminho fora de `/v1` responde 404.

## Objetos

**Resumo de mensagem** (`MessageSummary`):

```json
{
  "id": "uuid",
  "mailboxId": 1,
  "folder": "inbox",
  "from": { "address": "ana@example.net", "name": "Ana" },
  "subject": "Assunto",
  "snippet": "Primeiros 200 caracteres do texto",
  "date": "Tue, 28 Oct 2026 20:36:00 -0300",
  "receivedAt": "2026-10-28T23:36:20.236Z",
  "size": 12345,
  "hasAttachments": false,
  "isRead": false,
  "auth": { "spf": "pass", "dkim": "pass", "dmarc": "pass" },
  "parseStatus": "ok"
}
```

- `from` é `null` quando a mensagem não tem remetente legível. `name`, `subject`, `snippet` e `date` podem ser `null`.
- `date` é o cabeçalho `Date` como o remetente escreveu. Ordene sempre por `receivedAt`.
- `auth.*`: `pass`, `fail`, `none`, `neutral`, `softfail`, `temperror`, `permerror` ou `unknown`. **Ainda não serve para selo de "remetente verificado"** (`docs/decisoes.md`).
- `parseStatus`: `ok` ou `failed` (MIME quebrado; o `.eml` continua disponível em `/raw`).
- Pastas: `inbox`, `archive`, `spam`, `trash`, `sent`.

## Rotas

### `GET /v1/mailboxes`

Caixas que o usuário lê, em ordem de endereço, com as não lidas por pasta.

```json
{
  "mailboxes": [
    {
      "id": 1,
      "address": "contato@survivus.com.br",
      "displayName": "Contato",
      "unread": { "inbox": 2, "archive": 0, "spam": 1, "trash": 0, "sent": 0 }
    }
  ]
}
```

### `GET /v1/mailboxes/:id/messages?folder=&cursor=&limit=`

Mensagens de uma pasta, da mais nova para a mais antiga (`receivedAt`, depois `id`).

| Parâmetro | Regra | Padrão |
| --- | --- | --- |
| `:id` | Inteiro positivo. Sem permissão ou inexistente: 404 | |
| `folder` | Uma das 5 pastas | `inbox` |
| `limit` | 1 a 100 | 50 |
| `cursor` | O `nextCursor` da página anterior, sem alterar | (primeira página) |

```json
{ "messages": [MessageSummary], "nextCursor": "opaco ou null" }
```

`nextCursor` é `null` na última página. Uma mensagem que chega durante a paginação aparece só na primeira página de uma nova listagem, sem repetir nem pular as outras.

### `GET /v1/messages/:id`

O resumo, mais:

```json
{
  "to": [{ "address": "contato@survivus.com.br", "name": "" }],
  "cc": [],
  "messageId": "<abc@example.net>",
  "inReplyTo": null,
  "references": null,
  "body": { "text": "texto ou null", "html": "html ou null" },
  "attachments": [
    {
      "id": "uuid",
      "filename": "relatorio.pdf",
      "contentType": "application/pdf",
      "size": 2140000,
      "isInline": false,
      "contentId": null
    }
  ]
}
```

- `body` é `null` quando o parse falhou.
- **`body.html` vem cru**, do jeito que o remetente mandou. O webmail **tem** de sanitizar (DOMPurify) e exibir em `<iframe sandbox>` sem scripts (Etapa 6).
- `filename` e `contentType` são **declarados pelo remetente**: só para exibição. `filename` pode ser `null`.

### `GET /v1/messages/:id/attachments/:attId`

O arquivo do anexo. O anexo tem de ser da mensagem `:id`, e a permissão vem da caixa dessa mensagem: um `:attId` de outra mensagem dá 404.

Cabeçalhos da resposta, sempre:

```
Content-Type: application/octet-stream
Content-Disposition: attachment; filename="nome_ascii"; filename*=UTF-8''nome%20codificado
Content-Length: <tamanho>
X-Content-Type-Options: nosniff
Cache-Control: private, no-store
```

O tipo declarado pelo remetente **nunca** vai na resposta. O nome é limpo:
- caracteres de controle e de direção de texto removidos;
- `/` e `\` trocados por `_`;
- pontos e espaços do início removidos;
- no máximo 200 caracteres;
- vazio vira `anexo`.

### `GET /v1/messages/:id/raw`

O `.eml` original, com os mesmos cabeçalhos de download e o nome `<id>.eml`.

### `PATCH /v1/messages/:id`

Marca como lida/não lida e/ou move de pasta. Corpo JSON, com pelo menos um campo e nenhum campo a mais:

```json
{ "isRead": true, "folder": "archive" }
```

- `isRead`: booleano.
- `folder`: `inbox`, `archive`, `spam` ou `trash`. **`sent` não é aceito** (só o envio põe mensagens lá, na Etapa 8).
- Resposta: `{ "id": "uuid", "isRead": true, "folder": "archive" }`.
- JSON inválido, campo desconhecido, pasta `sent` ou desconhecida: 400, sem mudar nada.

### `POST /v1/search`

Busca no assunto, no endereço e no nome do remetente, só nas caixas que o usuário lê, em todas as pastas. O termo vai no **corpo**, nunca na URL, porque URLs acabam em logs (`docs/decisoes.md`, "Workers Logs desligados"). `GET /v1/search` responde 404.

```json
{ "q": "pedido", "mailbox": 1 }
```

| Campo | Regra |
| --- | --- |
| `q` | Texto de 1 a 100 caracteres, depois de tirar espaços das pontas. `%` e `_` são texto, não curinga |
| `mailbox` | Opcional: ID de uma caixa, como número JSON (`"1"` é recusado). Caixa sem permissão dá lista vazia |

JSON inválido, campo desconhecido ou tipo errado: 400.

```json
{ "messages": [MessageSummary] }
```

No máximo 50 resultados, do mais novo para o mais antigo. A comparação ignora maiúsculas só em letras sem acento (limite do `LIKE` do SQLite).

### `GET /v1/me` (grupo usuário)

O usuário do `X-Webmail-User`. O webmail usa para revalidar a sessão (no máximo a cada 5 minutos). Usuário desativado, apagado ou resetado e ainda não configurado: `401`, e o webmail apaga a sessão.

Resposta: `{"id","username","displayName","role","updatedAt"}`. `updatedAt` é a última mudança do usuário (ISO 8601 UTC; reset, configuração e `PATCH` atualizam; pode ser `null` em usuário antigo nunca alterado). O webmail apaga toda sessão criada antes dele.

```json
{ "id": "uuid", "username": "danielcraft221", "displayName": "Daniel", "role": "admin", "updatedAt": "2026-11-01T12:00:00.000Z" }
```

## Rotas de autenticação (grupo serviço, Etapa 5)

**O webmail verifica a senha e o código**, não o Worker (`docs/webmail-auth.md`). O Worker só guarda e devolve. Schemas de pedido e de resposta em `packages/shared/src/api.ts`.

Formatos aceitos:
- `username`: `^[a-z0-9][a-z0-9._-]{0,63}$`. O webmail normaliza para minúsculas antes de chamar.
- `tokenHash`: SHA-256 em hexadecimal minúsculo (64 caracteres) do token do link. **O token nunca chega à API.**
- `passwordHash`: string PHC do argon2id (`$argon2id$v=19$m=…,t=…,p=…$sal$hash`).
- `totpSecretEnc`: `v1.<iv>.<cifra+tag>`, em base64url. A API trata como opaco: só o webmail tem a chave.

### `POST /v1/auth/lookup`

Corpo: `{"username":"…"}` (no corpo, nunca na URL). **É a única resposta da API com o hash da senha e o segredo cifrado**: ela existe para isso.

```json
{ "id": "uuid", "active": true, "role": "admin", "passwordHash": "$argon2id$…", "totpSecretEnc": "v1.…" }
```

- Usuário inexistente: `404 {"error":"not_found"}`.
- `passwordHash` ou `totpSecretEnc` `null`: configuração pendente. **O webmail nunca deixa entrar**, mesmo com `active: true`.

### `POST /v1/auth/setup/lookup`

Corpo: `{"tokenHash":"…"}`. Link válido, não expirado e de usuário ativo: `{"id":"uuid","username":"…"}`. Qualquer outro caso: `404`.

### `POST /v1/auth/setup/complete`

Corpo: `{"tokenHash":"…","passwordHash":"…","totpSecretEnc":"…"}`.

- Grava a senha e o segredo e **apaga o link**, num único `UPDATE` condicional (link igual, não expirado, usuário ativo). Resposta: `{"id":"uuid","username":"…"}`.
- Link usado, expirado ou inexistente: `404`. Com duas chamadas ao mesmo tempo para o mesmo link, só uma grava; a outra recebe `404`.

### `POST /v1/audit`

Grava um evento do webmail no `audit_log`, com `source = "webmail"` (definido pelo token, nunca pelo corpo). Resposta: `204`.

```json
{ "action": "login_failure", "actorUserId": "uuid ou null", "target": "…", "ip": "2001:db8::1", "detail": { "reason": "bad_code" } }
```

- `action`: `login_success`, `login_failure`, `logout`, `ip_ban`, `username_lock` ou `setup_complete`. Só `action` é obrigatório.
- `actorUserId` desconhecido vira `null`. `target` tem até 100 caracteres. `ip` é IPv4 ou IPv6.
- `target`, os textos de `detail` e o `displayName` (rotas de admin) recusam caracteres de controle e de formatação (`\p{Cc}`, `\p{Cf}`): eles são impressos no terminal pela CLI, e uma sequência ANSI poderia apagar ou forjar linhas.
- `detail`: objeto plano, até 10 chaves, valores texto (até 100 caracteres), número, booleano ou `null`, até 500 caracteres no total. **Nunca senha, código, token ou cookie.** Tentativa com username inexistente não manda o username digitado.

## Rotas de administração (grupo administração, Etapa 5)

Usadas só pela CLI (`pnpm admin`). **Toda rota grava no `audit_log`**, com `source = "cli"`, `actor_user_id` vazio e o IP do `CF-Connecting-IP`. Nas rotas que mudam um usuário, o evento é gravado na mesma transação da mudança, e só se o usuário existir. Nenhuma resposta traz hash, segredo ou token.

**Usuário** (`AdminUser`):

```json
{
  "id": "uuid", "username": "ana", "displayName": "Ana", "role": "user", "active": true,
  "hasPassword": false, "hasTotp": false, "setupExpiresAt": "2026-11-01T20:00:00.000Z",
  "createdAt": "…", "updatedAt": "…"
}
```

`setupExpiresAt` é `null` quando não há link válido.

### `GET /v1/admin/users`

`{"users":[AdminUser…]}`, por username. Evento: `user_list`.

### `POST /v1/admin/users`

Corpo: `{"username":"ana","role":"user","displayName":"Ana","setupTokenHash":"…"}` (`role` padrão `user`; `displayName` opcional). A CLI gera o token do link e manda só o hash. **A validade (24 h) é definida pelo Worker**, não pela CLI.

- `201` com `AdminUser`. Username repetido: `409`.
- Evento: `user_create`, com `{username, role}`.

### `POST /v1/admin/users/:id/reset`

Corpo: `{"setupTokenHash":"…"}`. Apaga a senha e o segredo TOTP e grava o novo link (24 h). `200` com `AdminUser`; id inexistente ou malformado: `404`. Evento: `user_reset`. As sessões locais do webmail são derrubadas pela própria CLI.

### `PATCH /v1/admin/users/:id`

Corpo com ao menos um de: `active` (booleano), `role` (`admin`/`user`), `displayName` (texto ou `null`). `200` com `AdminUser`; `404` se não existir. Evento: `user_update`, com os campos mudados. Usuário desativado recebe `401` em toda rota do grupo usuário a partir do próximo pedido.

### `GET /v1/admin/audit?limit=`

Últimos eventos, do mais novo ao mais antigo. `limit` de 1 a 500, padrão 50. Evento: `audit_list`.

```json
{ "events": [ { "id": 1, "createdAt": "…", "source": "webmail", "actorUserId": "uuid", "action": "login_success", "target": null, "ip": "…", "detail": { "reason": "ok" } } ] }
```

### `POST /v1/admin/audit`

Ações locais da CLI (sessões e bans ficam no SQLite do webmail), para irem ao mesmo `audit_log`. Corpo: `{"action":"…","target":"…","detail":{…}}`, com `action` = `session_revoke`, `ip_ban`, `ip_unban` ou `username_unlock`. Resposta: `204`. Ações do webmail (`login_success` etc.) são recusadas com `400`.

## Logs

Cada pedido gera uma linha com:
- `user`: o UUID, só no grupo usuário e depois de autenticado;
- `route`: método e padrão da rota, por exemplo `GET /v1/messages/:id`;
- `httpStatus`;
- `ms`.

Nunca entram o caminho com IDs, a query string, o termo de busca, assunto, corpo, nome de anexo ou endereço de e-mail.

**Atenção (medido em 2026-10-29):** isso vale para o nosso `log()`. Com os Workers Logs ligados, a Cloudflare grava junto com cada linha a URL completa do pedido (`$workers.event.request.url`), com ids e query string. Por isso o armazenamento dos Workers Logs está desligado e a busca usa `POST` (`docs/decisoes.md`).

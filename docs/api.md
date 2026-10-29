# API interna do `mail-core`

Contrato que o webmail segue (Etapas 5 e 6). A API é usada **só pelo webmail**, de servidor para servidor. O código está em `apps/mail-core/src/api.ts` e os schemas dos pedidos em `packages/shared/src/api.ts` (`import { api } from "@webmail/shared"`).

- **Endereço:** `https://mail-api.survivus.com.br` (ligado no PR 2 da Etapa 3). O `workers.dev` continua desligado.
- **Formato:** JSON em UTF-8, nomes em `camelCase`. Datas em ISO 8601 UTC (`2026-10-28T23:36:20.236Z`).
- **Sem CORS:** nenhuma resposta tem cabeçalho `Access-Control-*`. Um navegador não consegue chamar a API.

## Autenticação: todo pedido em `/v1/*`

O webmail manda **quatro** cabeçalhos em todo pedido:

| Cabeçalho | Valor | Quem confere |
| --- | --- | --- |
| `CF-Access-Client-Id` | Client ID do Service Token `webmail` | Cloudflare Access, na borda |
| `CF-Access-Client-Secret` | Client Secret do Service Token | Cloudflare Access, na borda |
| `Authorization` | `Bearer <INTERNAL_API_TOKEN>` | Worker |
| `X-Webmail-User` | UUID do usuário logado no webmail | Worker, no D1 |

Sem o Service Token, o Access barra o pedido antes do Worker. Com ele, o Access acrescenta o `Cf-Access-Jwt-Assertion`, e o Worker confere, nesta ordem:

1. **JWT do Access:**
   - assinatura RS256 com as chaves de `https://<equipe>.cloudflareaccess.com/cdn-cgi/access/certs`;
   - `iss` exatamente igual ao team domain;
   - `aud` contendo o AUD da aplicação;
   - `exp` obrigatório;
   - `exp` e `nbf` com no máximo 60 s de tolerância de relógio;
   - `common_name` igual ao Client ID esperado.
2. **Bearer**, comparado em tempo constante.
3. **Usuário:** `X-Webmail-User` é um UUID de um usuário existente e ativo.
4. **Rate limit:** 100 pedidos por minuto por usuário (aproximado, por local da Cloudflare).

As falhas de 1 a 3 respondem `401 {"error":"unauthorized"}`, sem dizer qual passo falhou. Se faltar qualquer configuração (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_CLIENT_ID`, `INTERNAL_API_TOKEN`), todo pedido responde 401: a API fecha, não abre.

**O `X-Webmail-User` só identifica.** Ele nunca dá permissão: toda rota confere no D1 (`user_mailboxes.can_read`) se esse usuário lê a caixa.

## Erros

| Status | Corpo | Quando |
| --- | --- | --- |
| 400 | `{"error":"bad_request"}` | Parâmetro de busca/paginação ou corpo do `PATCH` inválido |
| 401 | `{"error":"unauthorized"}` | Autenticação (acima) |
| 404 | `{"error":"not_found"}` | Recurso inexistente, ID malformado **ou sem permissão**. As três respostas são idênticas |
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

### `GET /v1/search?q=&mailbox=`

Busca no assunto, no endereço e no nome do remetente, só nas caixas que o usuário lê, em todas as pastas.

| Parâmetro | Regra |
| --- | --- |
| `q` | 1 a 100 caracteres, depois de tirar espaços das pontas. `%` e `_` são texto, não curinga |
| `mailbox` | Opcional: ID de uma caixa. Caixa sem permissão dá lista vazia |

```json
{ "messages": [MessageSummary] }
```

No máximo 50 resultados, do mais novo para o mais antigo. A comparação ignora maiúsculas só em letras sem acento (limite do `LIKE` do SQLite).

## Logs

Cada pedido gera uma linha com:
- `user`: o UUID, só depois de autenticado;
- `route`: método e padrão da rota, por exemplo `GET /v1/messages/:id`;
- `httpStatus`;
- `ms`.

Nunca entram o caminho com IDs, a query string, o termo de busca, assunto, corpo, nome de anexo ou endereço de e-mail.

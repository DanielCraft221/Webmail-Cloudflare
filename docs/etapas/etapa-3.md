# Etapa 3: API interna de leitura (mail-core) com permissão em toda rota

> **Pré-requisito:** Etapa 2 concluída e mergeada (`docs/progresso.md` aponta a Etapa 3).
> As regras permanentes estão em `CLAUDE.md`. Siga-as durante toda a etapa.

## Objetivo

Dar ao futuro webmail (Etapas 5 e 6) uma API **só para ele**, servida pelo `mail-core`, para listar caixas e mensagens, ler mensagens, baixar anexos e marcar como lida ou mover de pasta. **Toda rota verifica, no D1, se o usuário tem permissão sobre a caixa.**

**Fora desta etapa:** login, senha e 2FA (Etapa 5), CLI de administração (Etapa 5), interface (Etapa 6), envio (Etapa 8), exclusão definitiva de mensagens (vai para "Depois").

## Antes de começar

1. Na `main`, rode `git pull --ff-only` e confirme que o `git status` está limpo.
2. Crie o branch `etapa-3/api` e mova este arquivo para `docs/etapas/etapa-3.md` nele.
3. Faça a pesquisa da tarefa 1.
4. Apresente o plano em tópicos curtos e **espere minha aprovação**.

## Fluxo: dois PRs (igual à Etapa 2)

- **PR 1, código (`etapa-3/api`):** pesquisa, migração `0002`, seed, middleware de autenticação e de permissão, rotas, testes e documentação. **Nenhuma mudança na Cloudflare.** `security-audit` antes de abrir o PR.
- **PR 2, implantação (`etapa-3/deploy`, a partir da `main` com o PR 1):** secrets, domínio da API, Cloudflare Access, deploy e testes reais com `curl`.
- **Deploy só a partir da `main` atualizada e com o `git status` limpo.**

## Decisões já tomadas (não reabra sem me perguntar)

- **Dois cadeados, independentes:**
  1. **Cloudflare Access com Service Token** na frente do hostname da API. Sem os cabeçalhos `CF-Access-Client-Id` e `CF-Access-Client-Secret`, a requisição é barrada na borda da Cloudflare e nem chega ao Worker.
  2. **Bearer token** (`INTERNAL_API_TOKEN`) verificado pelo Worker, comparado em tempo constante.

  Vazar um dos dois não basta para entrar.
- **O Worker também valida o JWT do Access** (`Cf-Access-Jwt-Assertion`: assinatura, `aud` e expiração). Se o Access for desligado ou mal configurado por engano, a API fica **fechada**, não aberta. É a mesma regra do `/admin` no `CLAUDE.md`.
- **Identidade do usuário:** o webmail informa o ID do usuário num cabeçalho (`X-Webmail-User`). O Worker **nunca** confia nele para permissão: toda rota consulta no D1 se esse usuário tem acesso à caixa.
- **Sem permissão = 404, não 403.** Quem não tem acesso não consegue nem descobrir se a mensagem existe.
- **Anexos e `.eml`:** sempre servidos com `Content-Type: application/octet-stream`, `Content-Disposition: attachment` (nome do arquivo saneado, em `filename*=UTF-8''...`), `X-Content-Type-Options: nosniff` e `Cache-Control: private, no-store`. **O tipo informado pelo remetente nunca é usado na resposta.** Ele vai só nos metadados (JSON), e o webmail decide o que fazer na Etapa 6.
- **O HTML do e-mail sai da API como dado, dentro de JSON**, nunca como `text/html`. A sanitização é do webmail (Etapa 6), conforme o `CLAUDE.md`.
- **Sem CORS.** A API é chamada de servidor para servidor. Nenhum cabeçalho `Access-Control-*`.
- **Mudanças na Cloudflare que exigem permissão de zona** (domínio da API, Access) **são feitas por mim no painel**, com você me guiando. O token do Wrangler continua sem permissões de zona.

## Tarefas

### 1. Pesquisa (PR 1, antes do código)

Confira na documentação atual da Cloudflare e registre em `docs/cloudflare-api.md`, com links:

- Como ligar um **domínio próprio** a um Worker pelo painel, e se isso cria o DNS sozinho.
- **Cloudflare Access para uma aplicação self-hosted com Service Token:** como criar o token, a política "Service Auth" e como o Worker valida o `Cf-Access-Jwt-Assertion` (onde buscar as chaves públicas, quais campos conferir).
- Se o plano tem o **binding de Rate Limiting** do Workers disponível e como usar.
- Como testar rotas HTTP com o `@cloudflare/vitest-plugin` (o `fetch` do Worker com bindings locais).

### 2. Banco de dados (PR 1: migração `0002`)

- `users`: id (UUID), username (único, minúsculas), nome de exibição, papel (`admin` ou `user`, com `CHECK`), ativo, data de criação. **Senha e 2FA ficam para a migração da Etapa 5**, não crie essas colunas agora.
- `user_mailboxes`: usuário, caixa, `can_read`, `can_send` (padrão 0, para a Etapa 8). Chave primária composta (usuário, caixa).
- Índice para buscar as caixas de um usuário.
- **Seed:** um usuário `daniel` (`admin`) com leitura nas três caixas do survivus.com.br. O username não é segredo.

### 3. Middleware (PR 1)

Na ordem, em **todas** as rotas `/v1/*`:

1. **Validação do JWT do Access** (assinatura, `aud`, expiração). Falhou → 401 genérico.
2. **Bearer token** em tempo constante. Falhou → 401 genérico.
3. **Usuário:** `X-Webmail-User` no formato UUID, usuário existente e ativo. Falhou → 401 genérico.
4. **Rate limit por usuário**, se a pesquisa confirmar que o binding existe no plano.

Respostas de erro: JSON curto, **sem stack trace, sem detalhe interno**, e sempre com `X-Content-Type-Options: nosniff` e `Cache-Control: no-store`.

### 4. Rotas (PR 1)

| Rota | O que faz |
|---|---|
| `GET /v1/mailboxes` | Caixas que o usuário pode ler, com contagem de não lidas por pasta |
| `GET /v1/mailboxes/:id/messages?folder=&cursor=&limit=` | Lista paginada por cursor (data de recebimento + id), `limit` máximo 100 |
| `GET /v1/messages/:id` | Metadados, corpo (`text` e `html` em JSON) e lista de anexos |
| `GET /v1/messages/:id/attachments/:attId` | Anexo, com os cabeçalhos da decisão acima |
| `GET /v1/messages/:id/raw` | `.eml` original, com os mesmos cabeçalhos de download |
| `PATCH /v1/messages/:id` | `is_read` e/ou `folder` (`inbox`, `archive`, `spam`, `trash`). `sent` não pode ser escolhido aqui |
| `GET /v1/search?q=&mailbox=` | Busca por assunto ou remetente, só nas caixas permitidas, `LIKE` com `%` e `_` escapados, limite de resultados |

- **Toda rota que recebe `:id` de mensagem descobre a caixa pela mensagem e confere a permissão do usuário nessa caixa.** Não confie em nenhum ID vindo da requisição para decidir acesso.
- Parâmetros validados com `zod` (UUID, enums, limites de tamanho).
- `GET /` e qualquer rota fora de `/v1` continuam respondendo 404.
- **Logs:** usuário, rota (sem query string), status e tempo. **Nunca** assunto, corpo, nome de anexo, endereço de e-mail ou o termo de busca.

### 5. Testes (PR 1)

Casos obrigatórios, além dos que você achar necessários:

| Caso | Esperado |
|---|---|
| Sem JWT do Access, ou JWT inválido/expirado/com `aud` errado | 401 |
| Sem bearer, ou bearer errado | 401 |
| `X-Webmail-User` ausente, inválido, inexistente ou inativo | 401 |
| Usuário sem permissão pede caixa, mensagem, anexo ou `.eml` | **404**, igual a recurso inexistente |
| Anexo de uma mensagem de outra caixa, usando `:attId` válido com `:id` permitido | 404 |
| Anexo com tipo `text/html` declarado pelo remetente | Resposta `application/octet-stream`, `attachment`, `nosniff` |
| Nome de anexo com aspas, quebra de linha, `../` e acentos | `Content-Disposition` seguro e correto |
| `PATCH` com pasta `sent` ou desconhecida | 400 |
| Busca com `%` e `_` | Tratados como texto, não como curinga |
| Busca não retorna mensagens de caixas sem permissão | Só caixas permitidas |
| Paginação | Sem repetir nem pular mensagens entre páginas |
| Erro interno | JSON genérico, sem stack trace |
| Logs | Sem assunto, corpo, endereço, nome de anexo ou termo de busca |
| Nenhuma resposta tem cabeçalho `Access-Control-*` | Confirmado |

### 6. Implantação (PR 2; cada passo na Cloudflare: mostre e espere meu "ok")

1. **Segredos, gerados por mim**, nunca por você nem no chat:
   ```bash
   mkdir -p ~/.config/webmail
   install -m 600 /dev/null ~/.config/webmail/api.env
   openssl rand -base64 48   # copio o resultado direto para o nano
   nano ~/.config/webmail/api.env
   ```
   Com `INTERNAL_API_TOKEN=...`. Depois `wrangler secret put INTERNAL_API_TOKEN`, digitando o mesmo valor. Esse arquivo vira a base do `.env` do webmail na Etapa 7.
2. **Domínio da API pelo painel:** `mail-api.survivus.com.br` ligado ao `mail-core`. Me guie tela a tela.
3. **Cloudflare Access pelo painel:** aplicação self-hosted para `mail-api.survivus.com.br`, Service Token `webmail`, política "Service Auth" só com esse token. O Client ID e o Client Secret vão para o mesmo `api.env`. O `aud` da aplicação entra como `vars` no `wrangler.jsonc` (não é segredo), por PR.
4. Migração `0002` e seed no D1 remoto.
5. Deploy a partir da `main` limpa.

### 7. Testes reais com `curl` (PR 2; eu rodo, você me passa os comandos)

Os comandos leem os valores de `~/.config/webmail/api.env` sem imprimi-los.

| Teste | Esperado |
|---|---|
| Sem nenhum cabeçalho | Barrado pelo Access (403 ou tela de login da Cloudflare), sem chegar ao Worker |
| Com o Service Token, sem bearer | 401 do Worker |
| Com os dois, usuário inexistente | 401 |
| Com os dois e o usuário `daniel` | `GET /v1/mailboxes` lista as três caixas |
| Ler a mensagem do teste 1 da Etapa 2 | Metadados e corpo corretos |
| Baixar o anexo do teste 1 | `application/octet-stream`, `attachment`, `nosniff`; o arquivo baixado tem o mesmo tamanho do D1 |
| `PATCH` marcando como lida | A contagem de não lidas muda em `GET /v1/mailboxes` |
| `https://mail-core.<conta>.workers.dev` | Continua sem responder |

### 8. Pendência herdada da Etapa 2: logs sem o endereço completo

A busca no painel não encontrou nem o domínio, então ela não provou nada. Faça com um **controle positivo**:

1. Ache no painel (Workers Logs) um evento que com certeza existe, por exemplo `queued`.
2. Se ele aparecer, procure o endereço completo de um remetente de teste. Não pode aparecer.
3. Se nem o `queued` aparecer, descubra por quê (logs desligados, período, retenção) e me explique antes de concluir.

### 9. Documentação

- `docs/api.md`: o contrato completo de cada rota (parâmetros, respostas, erros). É o que o webmail vai seguir na Etapa 5.
- `docs/cloudflare-api.md`: resultado da pesquisa.
- `docs/cloudflare.md`: passos do painel (domínio, Access, Service Token) para eu conseguir refazer sozinho.
- `docs/decisoes.md`: dois cadeados, 404 em vez de 403, anexos sempre como download, sem CORS.
- `docs/segredos.md`: `INTERNAL_API_TOKEN` e o Service Token do Access no inventário, sem valores.
- `CLAUDE.md`: seção "Comandos" e, se mudar, o diagrama.
- `docs/progresso.md`: ao fim de cada sessão.

## Critérios de pronto

| Teste | Esperado |
|---|---|
| Todos os casos da tarefa 5 | Passam no CI |
| Todos os testes reais da tarefa 7 | Resultado esperado |
| Requisição sem Service Token | Não chega ao Worker |
| Pendência dos logs (tarefa 8) | Resolvida com controle positivo |
| `gitleaks` no histórico | Nenhum vazamento; `api.env` fora do repositório |
| `docs/api.md` | Completo o bastante para o webmail ser escrito sem ler o código do Worker |
| `docs/progresso.md` | Etapa 3 concluída, próximo passo: Etapa 4 |

## Ao terminar

1. Mostre como eu mesmo testo cada critério, passo a passo.
2. Liste as dependências adicionadas e por que cada uma entrou.
3. Diga o que ficou pendente ou arriscado, principalmente o que a pesquisa não confirmou.
4. **Pare.** Não comece a Etapa 4.

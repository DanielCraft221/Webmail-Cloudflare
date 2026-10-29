# Cloudflare para a API interna: pesquisa (Etapa 3)

Pesquisa feita em 2026-10-29 na documentação oficial (developers.cloudflare.com). Confira de novo antes de mudar o código.

## Domínio próprio no Worker

Fonte: [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

- **Pelo painel:** Workers & Pages › escolha o Worker › **Settings** › **Domains & Routes** › **Add** › **Custom Domain**. Digite o hostname e confirme.
- **A Cloudflare cria sozinha o registro DNS e o certificado** do hostname.
- Não funciona num hostname que já tem um registro **CNAME**, nem numa zona que não é da conta.
- **Não documentado:** o que um `wrangler deploy` faz com um Custom Domain criado pelo painel e ausente do `wrangler.jsonc`. Conferir depois do primeiro deploy do PR 2 que o domínio continua lá. Declarar o domínio no `wrangler.jsonc` exigiria permissão de zona no token, que ele não tem (decisão da Etapa 3).

## Cloudflare Access com Service Token

Fontes: [Service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/), [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/), [Application token](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/)

### Criar o token e a política

- **Service Token:** Zero Trust › **Access controls** › **Service credentials** › **Service Tokens** › **Create Service Token**. Nome, duração (o exemplo usa 1 ano, `8760h`) e **Generate token**.
- **O Client Secret aparece uma única vez.** Perdeu, gera outro.
- O cliente manda os cabeçalhos `CF-Access-Client-Id` e `CF-Access-Client-Secret`.
- A política da aplicação usa a ação **Service Auth**, incluindo só esse token. Sem Service Auth, o Access pede login de identidade.
- Com a opção de autenticação estrita por service token ligada, uma falha responde **401 ou 403**, nunca um redirecionamento 302 para a tela de login. A página não diz qual é a resposta exata sem token nenhum. **Medido no PR 2:** sem cabeçalho, `403`. Com Service Token falso, `401`. Com a opção "Retorna a Resposta 401" da aplicação ligada, os dois casos dão `401`. A resposta do Access é `text/html`, com os cabeçalhos `cf-access-domain` e `cf-access-aud`.

### Validar o JWT no Worker

- Em toda requisição autenticada, o Access manda ao Worker o cabeçalho **`Cf-Access-Jwt-Assertion`**. A documentação recomenda validar o cabeçalho, não o cookie `CF_Authorization`.
- **Chaves públicas:** `https://<equipe>.cloudflareaccess.com/cdn-cgi/access/certs`, no formato JWKS (lista `keys`, RSA). Buscar em tempo de execução: as chaves trocam a cada 6 semanas, e a anterior vale por mais 7 dias.
- **Algoritmo:** RS256.
- **Campos a conferir:**
  - `iss` = `https://<equipe>.cloudflareaccess.com`;
  - `aud` = o AUD tag da aplicação;
  - `exp` e `nbf`, que a biblioteca `jose` confere sozinha.
- **Payload de um Service Token:** `type` = `app`, `sub` vazio, `common_name` = o Client ID do token. O exemplo não tem `nbf`: o código confere o `nbf` só quando ele vem, e exige o `exp`.
- **Exemplo oficial para Workers:** usa a biblioteca `jose` (`createRemoteJWKSet` e `jwtVerify`, com `issuer` e `audience`).

## Binding de Rate Limiting

Fontes: [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [changelog GA](https://developers.cloudflare.com/changelog/2025-09-19-ratelimit-workers-ga/)

- **Estável (GA) desde 2025-09-19.** Pede Wrangler 4.36.0 ou mais novo (o projeto usa 4.151.2).
- **Plano:** a documentação não diz se existe no Free. A conta é paga (as filas guardam 14 dias, só possível no pago), então está disponível.
- **Configuração:**

  ```jsonc
  "ratelimits": [
    { "name": "API_RATE_LIMIT", "namespace_id": "1001", "simple": { "limit": 100, "period": 60 } }
  ]
  ```

  O `period` só aceita `10` ou `60` segundos. O `namespace_id` é um número único na conta.
- **Uso:** `const { success } = await env.API_RATE_LIMIT.limit({ key: userId })`. A documentação recomenda chave estável (ID do usuário), não IP.
- **Precisão:** o limite vale **por local da Cloudflare** e é aproximado: pode deixar passar um pouco acima do limite. Serve contra abuso, não como cota exata.
- **Comportamento local:** a documentação não fala dele. **Medido no PR 1:** nos testes (Miniflare), o binding real deixa passar 100 pedidos e o 101º recebe 429.

## Testar rotas HTTP com `@cloudflare/vitest-plugin`

Fonte: [Write your first test](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)

- **Teste de unidade:**
  - chama `worker.fetch(request, env, ctx)` direto;
  - o `env` vem de `cloudflare:workers`;
  - `createExecutionContext()` e `waitOnExecutionContext(ctx)` vêm de `cloudflare:test`.
- **Teste de integração:** `exports.default.fetch(url)`, com `exports` de `cloudflare:workers`.
- Os bindings (D1, R2) são locais, os mesmos que os testes da Etapa 2 já usam.

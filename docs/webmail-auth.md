# Autenticação do webmail (Etapa 5)

Login por usuário + senha (argon2id) + código TOTP, sessões, rate limit e IP ban. Tarefa: `docs/etapas/etapa-5.md`.

## Pesquisa (2026-10-31)

### SvelteKit e `adapter-node`

Versões no npm em 2026-10-31: `@sveltejs/kit` 3.1.1, `@sveltejs/adapter-node` 6.0.1, `svelte` 5.57.3, `vite` 8.3.5. Todas MIT. O `@sveltejs/kit` 3 pede Node `>=22.17`.

Fonte: [adapter-node](https://svelte.dev/docs/kit/adapter-node) e [Configuration](https://svelte.dev/docs/kit/configuration).

- **`ORIGIN`:** no SvelteKit 3 **não é mais variável de ambiente do `adapter-node`**. A origem vai em `paths.origin`, no `vite.config.js` (`paths: { origin: process.env.ORIGIN }`). Ela é lida **no build**: a imagem Docker da Etapa 7 é gerada com `ORIGIN=https://webmail.survivus.com.br`. É também a origem confiável da checagem de CSRF.
- **`ADDRESS_HEADER`:** diz de qual cabeçalho vem o IP do cliente. Sem ele, o IP é o do socket (`remoteAddress`). A documentação avisa: "*Headers can easily be spoofed*". Em produção: `ADDRESS_HEADER=cf-connecting-ip`, confiável só porque apenas o cloudflared alcança o webmail.
- **`XFF_DEPTH`:** quantos proxies confiáveis existem na frente, para ler o `X-Forwarded-For` da direita para a esquerda. **Não usamos:** o `CF-Connecting-IP` tem um único IP e não precisa de profundidade.
- **`PROTOCOL_HEADER` / `HOST_HEADER`:** só atrás de um proxy confiável. Não precisamos: a origem é fixa no build.
- **`HOST` / `PORT`:** o padrão é `0.0.0.0:3000`. No container (Etapa 7) a rede é exclusiva do cloudflared. No desenvolvimento usamos o `vite dev` com `server.host: '127.0.0.1'`.
- **`BODY_SIZE_LIMIT`:** padrão de 512 KB, suficiente para o login.
- **CSRF:** `csrf.checkOrigin` está obsoleto e foi removido no 3.0. Hoje a opção é `csrf.trustedOrigins`, com padrão `[]`: só a própria origem pode enviar formulários (`POST`, `PUT`, `PATCH`, `DELETE`). **Nunca colocar `'*'`.** A checagem **só roda no build de produção**, não no `vite dev`. O teste de CSRF tem de rodar contra o build.
- **CSP:** `kit.csp` com `mode: 'auto'`, que usa nonce nas páginas renderizadas no servidor e hash nas pré-renderizadas. O SvelteKit põe o nonce ou o hash nos `<script>` e `<style>` que ele mesmo gera. As diretivas vão em `csp.directives`. Em página pré-renderizada, o `frame-ancestors` é ignorado (vai por `<meta>`). Por isso nenhuma página nossa é pré-renderizada.
- **Conferido ao montar o app (2026-11-01), o que mudou no kit 3:**
  - O `svelte.config.js` não existe mais (`config_file_unsupported`): a configuração vai em `sveltekit({ ... })` no `vite.config.ts`.
  - `$lib` virou `#lib`, declarado no campo `imports` do `package.json`, com extensão no import (`#lib/server/login.ts`).
  - `$app/environment` virou `$app/env`. Os tipos dos hooks (`Handle`, `ServerInit`) vêm de `@sveltejs/kit/hooks`.
  - O `tsconfig.json` estende `$app/tsconfig`, gerado pelo `svelte-kit sync`.
  - O kit e o `svelte-check` precisam do TypeScript 6 (`docs/decisoes.md`).
- **Versões:** kit 3.1.0, adapter-node 6.0.0 e svelte 5.57.2, porque a regra de 7 dias do pnpm barrou as mais novas. O kit 3.1.1 e o adapter-node 6.0.1 corrigem seis avisos de segurança; nenhum nos afeta como o app está, e `apps/webmail/test/forbidden-patterns.test.ts` impede o código de passar a usar o que eles corrigem. **O PR 3 só é mergeado depois de atualizar para essas versões** (`docs/progresso.md`).

### argon2id

Fonte: [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Mínimos da OWASP, todos equivalentes entre si: `m=47104` (46 MiB) com `t=1`; `m=19456` (19 MiB) com `t=2`; `m=12288` com `t=3`; `m=9216` com `t=4`; `m=7168` com `t=5`. Sempre com `p=1`.

**Sem dependência:** o Node 24 tem argon2id nativo (`crypto.argon2` e `crypto.argon2Sync`, adicionados na v24.7.0). **Estabilidade:** a seção não tem marcador próprio, então herda o do módulo `node:crypto`, "*Stability: 2 - Stable*" (conferido no [código-fonte da documentação do Node 24](https://github.com/nodejs/node/blob/v24.x/doc/api/crypto.md) em 2026-10-31). Mesmo assim, o PR 3 tem um teste com um valor conhecido: se a API mudar, ele quebra. O formato guardado é o PHC padrão (`$argon2id$v=19$m=…,t=…,p=…$sal$hash`), que leva os parâmetros junto: dá para subir o custo depois sem invalidar senhas antigas.

Medido neste servidor (Intel i5-4590, 4 núcleos, 16 GB) em 2026-10-31, com Node 24.22.1, mediana de 5 execuções:

| Parâmetros | Tempo |
|---|---|
| 19 MiB, t=2 (mínimo OWASP) | 33 ms |
| 46 MiB, t=1 (mínimo OWASP) | 48 ms |
| 64 MiB, t=2 | 116 ms |
| **64 MiB, t=3 (proposta)** | **166 ms** |
| 128 MiB, t=3 | 338 ms |

Memória: o pico do processo subiu 64 MiB numa verificação com 64 MiB (`VmHWM` de 47 para 111 MiB). Com no máximo 2 verificações simultâneas, o login usa até cerca de 128 MiB a mais.

**Escolha: 64 MiB, t=3, p=1.** Fica acima do mínimo da OWASP, cerca de 170 ms por login, e cabe no limite de memória do container. A versão assíncrona (`crypto.argon2`) roda fora da thread principal.

### TOTP (RFC 6238)

Fontes: [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238) e [Key Uri Format do Google Authenticator](https://github.com/google/google-authenticator/wiki/Key-Uri-Format).

- O Google Authenticator **ignora** os parâmetros `algorithm` e `period` (e `digits`, no Android). Ele sempre usa SHA-1, 6 dígitos e 30 segundos, que são também o padrão do formato. Com esses valores, Google Authenticator, Aegis e 2FAS geram o mesmo código. Valores diferentes geram códigos errados em silêncio.
- **Escolha:** SHA-1, 6 dígitos, 30 segundos, segredo de 20 bytes (160 bits, o tamanho que a RFC 4226 recomenda), em base32 na URI `otpauth://totp/…`.
- **Janela:** a RFC 6238 (seção 5.2) recomenda aceitar no máximo um passo para trás, por atraso de rede. A etapa decidiu ±1 passo (30 s para cada lado), o mais comum nos serviços. Com o último passo aceito guardado por usuário, um código não vale duas vezes.
- **Sem dependência:** o TOTP é um HMAC-SHA-1 com truncamento (cerca de 20 linhas com `node:crypto`), testado com os vetores do apêndice B da RFC 6238.

### Cookie `__Host-` em `http://localhost`

Fonte: [httpwg/http-extensions#2605](https://github.com/httpwg/http-extensions/issues/2605).

- **Firefox:** aceita cookie `Secure` e cookie `__Host-` em `http://localhost`, que ele trata como origem confiável.
- **Chrome:** aceita cookie `Secure` em `http://localhost`, mas **recusa** os prefixos `__Host-` e `__Secure-`. A correção está aberta como "*in scope*" (Chromium 1245434). **Não achei confirmação de que foi corrigida.**
- **Proposta, sem enfraquecer a produção:** o nome do cookie vem do `dev` de `$app/environment`, que só é `true` no `vite dev`. O build (produção e testes no navegador) sempre usa `__Host-webmail_session`. Só o servidor de desenvolvimento usa `webmail_session`, com os mesmos `HttpOnly`, `Secure`, `SameSite=Lax` e `Path=/`. Um teste confere que o build define o `__Host-`.
- Os testes no navegador rodam contra o build. Para o cookie `__Host-` funcionar em `localhost`, eles usam o **Firefox** do Playwright, não o Chromium.

### Node LTS

Fonte: [calendário oficial](https://github.com/nodejs/Release/blob/main/schedule.json).

| Versão | LTS desde | Manutenção desde | Fim |
|---|---|---|---|
| 24 | 2025-10-28 | **2026-10-20** | 2028-04-30 |
| 26 | **2026-10-28** | 2027-10-20 | 2029-04-30 |

- O **Node 26 é a LTS ativa desde 2026-10-28**. O 24, que o projeto usa hoje (24.22.1 no servidor, `engines` no `package.json`), entrou em manutenção e recebe só correções de segurança até 2028-04-30.
- A Etapa 7 usa no Dockerfile a mesma versão do desenvolvimento.

## Fluxos

### Primeiro acesso e reset (link de configuração)

1. A CLI (`user:create` ou `user:reset`) gera um token aleatório, manda **só o SHA-256 dele** ao Worker (`POST /v1/admin/users` ou `/reset`) e mostra o link `/setup/<token>` uma única vez. O Worker define a validade de 24 h. O reset também apaga a senha e o segredo TOTP no D1 e a CLI derruba as sessões locais.
2. Daniel manda o link à pessoa por um canal seguro.
3. A pessoa abre o link. O webmail calcula o SHA-256 do token e chama `POST /v1/auth/setup/lookup`. Inválido, usado ou expirado: a página diz só que o link não vale.
4. A página mostra o QR code (gerado no servidor, imagem `data:`) e o segredo em texto. O segredo fica **em andamento no SQLite local por até 10 minutos**, preso ao link; recarregar a página dentro desse prazo mostra o mesmo.
5. Ela preenche **num único formulário** a senha (12 a 128 caracteres, diferente do username), a confirmação e um código do aplicativo. Assim a senha nunca fica guardada, nem por 10 minutos. Só com o código certo o webmail calcula o argon2id, cifra o segredo (AES-256-GCM, AAD = id do usuário) e chama `POST /v1/auth/setup/complete`, que grava tudo e apaga o link numa única operação.
6. O código usado na configuração fica marcado como usado: não serve para o primeiro login. A página manda para `/login?configurado`.
7. Link inválido e código errado contam como falha do IP (o mesmo ban do login). A página também tem limite de 30 pedidos por IP em 15 minutos.

### Login

1. **Ban do IP checado primeiro** (IPv6 pelo `/64`), antes de ler o corpo e antes do argon2.
2. Username bloqueado por excesso de falhas (5 do mesmo bloco de IP, ou 50 de todos os IPs, em 15 minutos): recusa sem argon2, com a mensagem genérica. Tentativas durante o bloqueio não o renovam.
3. `POST /v1/auth/lookup`. Usuário inexistente: verificação contra o hash falso, para gastar o mesmo tempo.
4. Recusa se o usuário estiver inativo ou sem senha ou sem 2FA.
5. argon2id (no máximo 2 ao mesmo tempo; além disso, `503`), depois o código TOTP (±1 passo, nunca um passo já usado).
6. Qualquer falha: "Usuário, senha ou código inválidos", contada para o IP e para o username, e gravada no `audit_log` com o motivo interno (`unknown_user`, `inactive`, `not_configured`, `bad_password`, `bad_code`, `code_reused`, `decrypt_failed`, `username_locked`). Sucesso: sessão nova (cookie com token de 32 bytes; o SQLite guarda só o SHA-256).
7. Ban ativo: `429` com "Muitas tentativas. Tente de novo mais tarde.", sem ler o corpo, sem argon2 e sem chamar a API.

### Sessão

- Cookie `__Host-webmail_session` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`). Só o `vite dev` usa `webmail_session`, porque o Chrome recusa `__Host-` em `http://localhost`.
- Expira com 2 h sem uso ou 12 h de vida. No máximo 10 por usuário: a mais antiga cai.
- O primeiro pedido depois do login e depois um a cada 5 minutos chamam `GET /v1/me`. Resposta `401` (usuário desativado): todas as sessões dele são apagadas. Erro de rede: `503`, sem entrar.

### IP do cliente

- Produção (todo build; só o `vite dev` não é, qualquer que seja o `NODE_ENV`): só o `CF-Connecting-IP`. Ausente ou inválido: `400`. O app não sobe sem `ADDRESS_HEADER=cf-connecting-ip`.
- Desenvolvimento: o IP do socket.
- IPv6 conta pelo bloco `/64` nos limites e nos bans.

### Testes

- **Unitários** (`apps/webmail/test`, Vitest): vetores da RFC 4648 (base32), da RFC 6238 (TOTP, SHA-1/256/512) e da RFC 9106 (argon2id), cifra com AAD, limites, sessões, login, configuração, CLI e a lista de padrões proibidos.
- **HTTP contra o build de produção** (`apps/webmail/e2e/http`, Playwright, sem navegador): CSRF, cookie, cabeçalhos, `400` sem IP, app que não sobe, bans, bloqueios e fluxos completos. Depois deles, `e2e/logs.spec.ts` confere que nenhuma senha, código, token ou cookie usado chegou ao log do app. Rodam em todo `pnpm test`.
- **Navegador** (`apps/webmail/e2e/browser`, Firefox): só na CI. O Firefox precisa de bibliotecas gráficas que pediriam `sudo` no servidor de produção.
- Todos usam o Worker falso (`apps/webmail/test/fake-worker.ts`), que segue o `docs/api.md` com os schemas de `packages/shared`. Nunca a API real nem segredos reais.

### Formato do segredo cifrado

`v1.<iv>.<cifra+tag>`, em base64url: IV de 12 bytes, AES-256-GCM com tag de 16 bytes, AAD = id do usuário. O `v1` permite trocar o formato depois sem ambiguidade. O Worker trata o valor como opaco e só confere o formato.

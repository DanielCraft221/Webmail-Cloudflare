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

### argon2id

Fonte: [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Mínimos da OWASP, todos equivalentes entre si: `m=47104` (46 MiB) com `t=1`; `m=19456` (19 MiB) com `t=2`; `m=12288` com `t=3`; `m=9216` com `t=4`; `m=7168` com `t=5`. Sempre com `p=1`.

**Sem dependência:** o Node 24 tem argon2id nativo (`crypto.argon2`, desde o 24.7). O formato guardado é o PHC padrão (`$argon2id$v=19$m=…,t=…,p=…$sal$hash`), que leva os parâmetros junto: dá para subir o custo depois sem invalidar senhas antigas.

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

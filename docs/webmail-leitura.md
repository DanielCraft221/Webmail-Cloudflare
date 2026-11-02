# Webmail: leitura segura de mensagens (Etapa 6)

Pesquisa da tarefa 1, feita em 2026-11-02. A configuração final e as três camadas entram aqui no PR 1.

## DOMPurify no Node

Fonte: [README do DOMPurify](https://github.com/cure53/DOMPurify/blob/main/README.md), seção "Running DOMPurify on the server".

- **Forma recomendada:** `createDOMPurify(new JSDOM("").window)`. O README manda usar **o jsdom mais novo**: versões antigas "are known to be buggy in ways that result in XSS".
- **happy-dom:** o README diz que "is not considered safe" com o DOMPurify. **linkedom** e o `purify-edge` também não são mantidos nem garantidos pelo projeto. Ficamos no jsdom.
- **jsdom** ([README](https://github.com/jsdom/jsdom/blob/main/README.md)): por padrão não executa scripts e não carrega nenhum sub-recurso (scripts, CSS, imagens, iframes). O próprio README avisa que o sandbox dele "is not foolproof" com `runScripts`. Regra: **nunca** passar `runScripts` nem `resources` ao `JSDOM`. O jsdom só faz o parse; quem decide o que sobra é o DOMPurify.

### O que o DOMPurify faz e não faz por padrão (medido com 3.4.17)

Um e-mail de teste com `<style>` no `<head>`, `<meta http-equiv="refresh">`, SVG com script, `javascript:` e um `<form>`:

| Configuração | Resultado |
|---|---|
| `USE_PROFILES: { html: true }` | Tira SVG, `<meta>`, `javascript:` e `target`. **Mantém `<form action="https://…">` e `<input>`.** Perde o `<style>` do `<head>` |
| `+ WHOLE_DOCUMENT: true` | Igual, mas **mantém o `<style>` do `<head>`**, de que as newsletters dependem |

Conclusões:
- **O perfil padrão não basta**: formulários passam. A configuração é **por lista do que é permitido** (`ALLOWED_TAGS` e `ALLOWED_ATTR` explícitos), como a etapa pede. Sem `form`, `input`, `button`, `select`, `textarea`, `base`, `meta`, `link`, `iframe`, `object`, `embed`, `svg` e `math`.
- **`WHOLE_DOCUMENT: true`**, para manter o CSS do `<head>`.
- **O DOMPurify não olha o conteúdo do CSS.** O README diz que ele "per default allows CSS". Por isso:
  - hook em `uponSanitizeElement` para `<style>`: tira `@import` e todo `url(...)`;
  - hook em `afterSanitizeAttributes` para o atributo `style`: tira as declarações com `url(...)`;
  - a CSP da rota do corpo (`img-src data:`, sem `font-src`) bloqueia o que escapar.
- **Links:** `ALLOWED_URI_REGEXP` só com `http:`, `https:` e `mailto:` (o padrão aceita também `ftp`, `tel`, `sms`, `cid`, `xmpp` e outros). Um link com outro esquema perde o `href` e vira texto. O hook `afterSanitizeAttributes` põe `target="_blank"` e `rel="noopener noreferrer"`. O README avisa que a saída dos hooks `afterSanitize*` não é conferida de novo, então eles só **removem** ou gravam valores fixos.
- **Imagens:** `src` remoto removido e contado em `blockedImages`. `data:` passa (a CSP aceita `data:`). `cid:` fica para "Depois".

### Avisos de segurança

Lista do [GitHub Advisory Database](https://github.com/advisories?query=dompurify) em 2026-11-02:
- **DOMPurify:** cerca de 30 avisos desde 2024, todos corrigidos até a **3.4.17**. Os três mais recentes são de 2026-10-22: um crítico (`SAFE_FOR_TEMPLATES`), um alto (`IN_PLACE`) e um baixo (SMIL com `PARSER_MEDIA_TYPE` XML).
- **jsdom:** nenhum aviso em vigor; o único é de 2021 e foi retirado.

Quase todos os avisos do DOMPurify estão em recursos de que não precisamos. **Não usar, com teste que proíbe** (como o `forbidden-patterns.test.ts` da Etapa 5):

| Recurso | Avisos |
|---|---|
| `IN_PLACE` | GHSA-mrv2-3pqr-j5jr, GHSA-55q2-fjhq-7xh7, GHSA-rp9w-3fw7-7cwq e outros |
| `SAFE_FOR_TEMPLATES` | GHSA-cg2g-xh64-v4q7 (crítico), GHSA-gvmj-g25r-r7wr |
| `CUSTOM_ELEMENT_HANDLING` | GHSA-c2j3-45gr-mqc4, GHSA-v9jr-rg53-9pgp |
| `ADD_TAGS`/`ADD_ATTR` em forma de função | GHSA-h7mw-gpvr-xq4m, GHSA-cjmm-f4jc-qw8r |
| `setConfig()`, `RETURN_DOM`, `RETURN_TRUSTED_TYPE` e hooks que mexem em `data.allowedTags` | GHSA-cmwh-pvxp-8882, GHSA-76mc-f452-cxcm |
| `PARSER_MEDIA_TYPE` | GHSA-c6gr-qvv4-5v3f |

A configuração vai **em cada chamada** a `sanitize()`, sempre o mesmo objeto congelado.

Os avisos de mXSS (GHSA-h8r8-wccr-v5f2, GHSA-gx9m-whjm-85jf) são o motivo de duas regras:
- manter a versão em dia;
- a terceira camada (CSP da rota mais o `sandbox`) não depender do DOMPurify.

## Custo real

Medido neste servidor (Intel i5-4590, 4 núcleos), Node 24.22.1, DOMPurify 3.4.17 e jsdom 30.1.3. O e-mail é uma newsletter sintética: tabelas, estilos inline, uma imagem remota e dois links por bloco. Script fora do repositório.

| HTML | Tempo (mediana de 5) | Pico de memória do processo |
|---|---|---|
| 100 KB | 209 ms | +140 MiB |
| 1 MB | 1,6 s | +350 MiB |
| 2 MB | 3,2 s | +690 MiB |
| 5 MB | 8,1 s | +1,5 GiB |

Duas sanitizações ao mesmo tempo, cada uma num `worker_thread` (pico do processo inteiro, partida dos workers incluída):

| HTML | Tempo total | Pico |
|---|---|---|
| 2 × 1 MB | 2,9 s | 684 MiB |
| 2 × 2 MB | 4,6 s | 819 MiB |
| 2 × 5 MB | 9,9 s | 1,2 GiB |

**O custo está no parse do jsdom, não no DOMPurify.** O parse sozinho de 1 MB levou 1,7 s numa execução fria.

Conclusões:
- **A sanitização é síncrona.** Na thread principal, 1 MB travaria o servidor inteiro, inclusive o login de todo mundo, por 1,6 s. Ela tem de rodar em **`worker_threads`** (biblioteca padrão do Node). São dois workers fixos, cada um com o seu jsdom; o terceiro pedido recebe 503.
- **Limite proposto: 1 MB de HTML**, não 2 MB. Com 1 MB, duas sanitizações juntas ficam abaixo de 700 MiB e cerca de 3 s. Com 2 MB, passam de 800 MiB num container que divide 4 GB com o cloudflared. Uma newsletter típica tem bem menos de 200 KB.
- **Cada worker com `resourceLimits`** (teto de memória do heap) e um tempo máximo. Se passar, o worker é encerrado e recriado, e a página mostra o texto e o botão do `.eml`, como no HTML grande.
- O VPS tem outro processador. **Medir de novo na Etapa 7**, já no container.

## `srcdoc` herda a CSP da página

- Um iframe com `srcdoc` recebe a política da página-mãe. Fontes:
  - o teste da plataforma web [`content-security-policy/inheritance/iframe-all-local-schemes`](https://searchfox.org/mozilla-central/source/testing/web-platform/tests/content-security-policy/inheritance/iframe-all-local-schemes.sub.html);
  - a [discussão original do WHATWG](https://lists.whatwg.org/pipermail/whatwg-whatwg.org/2012-June/078745.html): o documento `srcdoc` recebe a origem da página, então a CSP dela vale nele, para não abrir uma brecha.
- Com `sandbox` sem `allow-same-origin` também: o [CVE-2017-7788 do Firefox](https://www.mozilla.org/en-US/security/advisories/mfsa2017-18/) foi justamente um `srcdoc` com `sandbox` que **não** herdava a CSP, corrigido para herdar.
- A CSP do webmail não tem `'unsafe-inline'` em `style-src`. Com `srcdoc`, os estilos inline do e-mail seriam bloqueados. **Confirmado: precisamos da rota própria**, com uma CSP só dela.

## A diretiva `sandbox` da CSP

Fonte: [MDN, CSP `sandbox`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox) e [CSP3](https://www.w3.org/TR/CSP3/) (§ 3.3 e § 4.2).

- Ela aplica ao **documento pedido** as mesmas restrições do atributo `sandbox` do iframe. A CSP3 diz que ela preenche as "CSP-derived sandboxing flags" do documento. Por isso vale também quando a URL do corpo é aberta direto, fora do iframe. A MDN confirma que os valores de navegação do topo "have no effect" em documentos soltos, o que só faz sentido se a diretiva se aplica a eles.
- Sem `allow-same-origin`, o documento tem **origem opaca** (`null`): não lê cookie, `localStorage` nem a página do webmail. Sem `allow-scripts`, nenhum script roda.
- **Não funciona em `<meta>` nem em `Content-Security-Policy-Report-Only`.** Tem de ir no cabeçalho de verdade.
- Disponível em todos os navegadores desde 2016 (Baseline).
- **A confirmar no PR 1, no Firefox da CI:** abrir a URL do corpo direto e verificar que um script do corpus não roda e que `document.cookie` não é alcançável.

## Atributos do `sandbox` do iframe

| Atributo | Usar? | Motivo |
|---|---|---|
| `allow-popups` | Sim | Sem ele, `target="_blank"` "will silently fail" |
| `allow-popups-to-escape-sandbox` | Sim | A aba nova abre sem as restrições do sandbox; senão, o site do link quebra |
| `allow-same-origin` | **Não** | Daria a origem do webmail ao e-mail (cookie, `localStorage`) |
| `allow-scripts` | **Não** | Junto com `allow-same-origin`, o conteúdo poderia tirar o próprio sandbox |
| `allow-top-navigation*` | **Não** | O e-mail poderia trocar a página do webmail por uma falsa |
| `allow-forms`, `allow-modals`, `allow-downloads` | **Não** | Formulário de phishing, `alert` e download disparado pelo e-mail |

Como o documento do corpo tem origem opaca e `rel="noreferrer"`, um link aberto não manda `Referer`. A rota do corpo também manda `Referrer-Policy: no-referrer`, porque ela não tem formulário, ao contrário das outras páginas.

## O que muda no código atual

Achados ao ler o código da Etapa 5:
- **`X-Frame-Options: DENY` em toda resposta** (`hooks.server.ts`). Ele bloquearia o iframe do corpo. A rota do corpo, e só ela, vai com `SAMEORIGIN`, junto com `frame-ancestors 'self'`. Um teste confere que todo o resto continua com `DENY` e `frame-ancestors 'none'`.
- **A CSP das páginas** tem `default-src 'self'`, o que já permite um iframe da mesma origem (`frame-src` herda de `default-src`). Não precisa mudar.
- **O `secure()` do hook** troca o `Cache-Control` por `no-store` e só põe a CSP de reserva se a resposta não tiver uma. A rota do corpo e os downloads montam os cabeçalhos deles, e o hook tem de respeitá-los.
- **O cliente da API** (`worker-api.ts`) ainda não tem as rotas de leitura: caixas, lista, mensagem, anexo, `.eml`, `PATCH` e busca. Os downloads são stream, sem passar pelo schema `zod`. O webmail monta uma resposta nova e nunca devolve a do Worker.

## Dependências e licenças

Versões no npm em 2026-11-02, dentro da regra de 7 dias do pnpm:
- **`dompurify` 3.4.17** (2026-10-12), licença dupla `MPL-2.0 OR Apache-2.0`. **Usamos a Apache-2.0**, compatível com a AGPL-3.0. Única dependência: `@types/trusted-types` (MIT, só tipos).
- **`jsdom` 30.1.3** (2026-10-15), MIT. Pede Node `^24.15.0` (temos 24.22.1).

As duas, com as dependências, somam 38 pacotes:

| Licença | Pacotes |
|---|---|
| MIT | 27, entre eles `jsdom`, `parse5`, `whatwg-url`, `undici` e `css-tree` |
| MIT-0 | `@csstools/color-helpers`, `@csstools/css-syntax-patches-for-csstree` |
| BSD-2-Clause | `entities`, `webidl-conversions` |
| BSD-3-Clause | `tough-cookie`, `source-map-js` |
| ISC | `saxes` |
| Apache-2.0 | `xml-name-validator` |
| CC0-1.0 | `mdn-data` (só dados) |
| **BlueOak-1.0.0** | **`lru-cache`** |
| `MPL-2.0 OR Apache-2.0` | `dompurify` (usamos a Apache-2.0) |

**Exceção para Daniel decidir:** o `lru-cache` usa a [Blue Oak Model License 1.0.0](https://blueoakcouncil.org/license/1.0.0). É uma licença permissiva, aprovada pela OSI, sem cláusula que conflite com a AGPL, mas não está na lista do `CLAUDE.md`. O CC0-1.0 é domínio público, compatível. Os dois são novos no projeto.

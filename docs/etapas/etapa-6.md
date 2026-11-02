# Etapa 6: Webmail: caixas, lista e leitura de mensagens com HTML sanitizado

> **Pré-requisito do código:** PR 3 da Etapa 5 mergeado e a tarefa 8 feita (minha conta real com 2FA).
> **A pesquisa (tarefa 1) pode começar antes**, num branch só de docs criado a partir da `main` (`etapa-6/pesquisa`). Nenhuma linha de código antes do merge da Etapa 5.
> As regras permanentes estão em `CLAUDE.md`. Siga-as durante toda a etapa.

## Objetivo

Depois de entrar no webmail, eu vejo as minhas caixas, a lista de mensagens de cada pasta, abro uma mensagem com o HTML **sanitizado e isolado**, baixo anexos e o `.eml`, marco como lida ou não lida, movo de pasta e busco. Tudo pela API da Etapa 3, sem mudar o Worker.

**Fora desta etapa:** envio e resposta (Etapa 8), permissões por caixa pela CLI (Etapa 9), botão "carregar imagens remotas", imagens inline (`cid:`), selo de "remetente verificado", visão por conversa e exclusão definitiva. Tudo isso vai para "Depois".

## Fluxo: dois PRs

- **PR 1, núcleo de segurança (`etapa-6/leitura-segura`):** sanitização, rota do corpo da mensagem com CSP própria, downloads, corpus de ataques e testes no navegador. **Revisão independente por sessão nova** antes de abrir o PR, como na Etapa 5.
- **PR 2, interface (`etapa-6/interface`):** caixas, lista, leitura, ações, busca, celular e acessibilidade (`web-quality-audit`).
- `security-audit` antes de **cada** PR. Nenhuma mudança na Cloudflare nesta etapa.

## Decisões já tomadas (não reabra sem me perguntar)

**Onde e como o HTML é tratado:**
- **Três camadas, independentes.** Uma falha numa camada não pode bastar para um ataque:
  1. **DOMPurify no servidor** remove scripts, eventos, `javascript:`, formulários, `<base>`, `<meta>`, `<iframe>`, `<object>`, SVG e MathML.
  2. **Rota própria para o corpo** (`/mensagens/[id]/corpo`) com uma **CSP só dela**: `default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`. Mesmo que o DOMPurify deixe passar algo, o navegador não carrega nada externo nem roda script.
  3. **`<iframe sandbox>`** sem `allow-scripts` e sem `allow-same-origin`, com `referrerpolicy="no-referrer"`. Só `allow-popups` e `allow-popups-to-escape-sandbox`, para os links abrirem em outra aba.
- **Por que uma rota própria, e não `srcdoc`:** um iframe com `srcdoc` herda a CSP da página do webmail. Essa CSP proíbe estilos inline, e os e-mails dependem deles. A pesquisa confirma esse comportamento.
- **A CSP da rota do corpo é diferente da do resto do app**, e um teste garante que só essa rota tem `frame-ancestors 'self'` e `style-src 'unsafe-inline'`. Todo o resto continua com `frame-ancestors 'none'`.
- **Imagens remotas bloqueadas sempre**, pela CSP (`img-src data:`). A sanitização também troca o `src` remoto por um aviso, mas quem garante o bloqueio é a CSP, porque ela também pega o `url()` do CSS. Na página da mensagem aparece "Imagens remotas bloqueadas".
- **Links do e-mail:** `target="_blank"` e `rel="noopener noreferrer"`. Só `http:`, `https:` e `mailto:`. Qualquer outro esquema vira texto.
- **E-mail só com texto:** exibido como texto escapado, com quebras de linha preservadas. Links no texto não viram clicáveis nesta etapa.
- **HTML muito grande** (acima de 2 MB, número a medir na pesquisa): não é sanitizado. A página mostra a versão em texto e o botão para baixar o `.eml`.
- **No máximo 2 sanitizações ao mesmo tempo.** Além disso → 503, como o argon2 na Etapa 5.

**Downloads (regra da Etapa 3 e aviso do adapter-node):**
- O webmail **nunca devolve a resposta crua** do `fetch` ao Worker. Ele monta uma resposta nova, com os cabeçalhos dele: `application/octet-stream`, `Content-Disposition: attachment` com o nome saneado, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`. O corpo pode ser repassado como stream.
- O tipo informado pelo remetente nunca vira `Content-Type`.

**Identidade do remetente (pendência da Etapa 2):**
- **Nenhum selo de "verificado" nesta etapa.** O cabeçalho `Authentication-Results` pode ter sido forjado por quem enviou, e um selo errado é pior do que nenhum.
- O remetente aparece sempre com **o nome e o endereço real**, lado a lado: `Fulano <fulano@exemplo.com>`. Nunca só o nome.

**Ações e navegação:**
- **Nada que mude estado acontece num GET.** O SvelteKit pré-carrega links quando o mouse passa por cima. Se abrir a mensagem marcasse como lida no carregamento, passar o mouse pela lista marcaria tudo como lido. Marcar como lida é uma *form action* (POST), disparada depois que a página abre.
- **Os links da lista de mensagens não pré-carregam dados** (`data-sveltekit-preload-data="off"`).
- **Busca por POST**, nunca `?q=` na URL. Na Etapa 3, a API passou a usar `POST /v1/search` para o termo não ir para logs e histórico. O webmail segue a mesma regra.
- **Quem decide o acesso é o Worker.** O webmail nunca usa o ID que vem na URL para decidir permissão. Um 404 da API vira "Mensagem não encontrada", sem distinguir entre "não existe" e "sem permissão".
- **Toda página logada** tem `Cache-Control: no-store`.

## Tarefas

### 1. Pesquisa (pode começar antes do merge da Etapa 5)

Confira na documentação atual e registre em `docs/webmail-leitura.md`, com links:

- **DOMPurify no Node:** a forma recomendada hoje (com `jsdom`), a configuração para e-mail (tags e atributos permitidos, `FORBID_TAGS`, `FORBID_ATTR`, hooks para links e imagens) e os avisos de segurança recentes do DOMPurify e do `jsdom`.
- **Custo real:** memória e tempo para sanitizar e-mails típicos (newsletter de 100 KB, e-mail de 1 MB) no Node 24. Isso define o limite de tamanho e confirma que 2 sanitizações simultâneas cabem nos 4 GB da VPS.
- **`srcdoc` e a herança de CSP:** confirme que um iframe com `srcdoc` herda a política da página-mãe. Confirme também que a diretiva `sandbox` da CSP isola a rota do corpo mesmo quando alguém abre essa URL direto.
- **Atributos de `sandbox`** necessários para os links abrirem em outra aba sem dar acesso ao webmail.
- **Licenças e versões**, respeitando a regra de 7 dias do pnpm. O DOMPurify tem licença dupla (Apache-2.0 ou MPL-2.0): registre que usamos a Apache-2.0, compatível com a AGPL.

### 2. Sanitização (PR 1)

- Módulo único `sanitizeEmailHtml(html): { html, blockedImages }`, testado sozinho.
- Configuração **por lista do que é permitido**, não do que é proibido.
- Hook de links (esquemas permitidos, `target`, `rel`) e hook de imagens (remota → aviso e contagem).
- Remove `<style>` com `@import` e qualquer `url()` remoto. A CSP também bloqueia, mas a ideia é não depender de uma camada só.

### 3. Rota do corpo e downloads (PR 1)

- `GET /mensagens/[id]/corpo`: exige sessão, busca a mensagem na API, sanitiza e responde `text/html` com a CSP da decisão acima.
- `GET /mensagens/[id]/anexos/[attId]` e `GET /mensagens/[id]/eml`: resposta montada pelo webmail, com os cabeçalhos da decisão acima.
- Os logs registram só o `route.id`, nunca o ID da mensagem com o assunto, nem o nome do anexo.

### 4. Interface (PR 2)

- **Caixas:** lista com contagem de não lidas por pasta (`inbox`, `archive`, `spam`, `trash`, `sent`).
- **Lista de mensagens:** remetente (nome e endereço), assunto, data, marca de não lida e de anexo. Paginação por cursor, 50 por página.
- **Leitura:** cabeçalhos (de, para, data, assunto), o iframe do corpo, a lista de anexos com tamanho, o botão do `.eml`, o aviso de imagens bloqueadas e um botão para alternar entre HTML e texto.
- **Avisos fora do iframe** (decisão de Daniel, 2026-11-02): o aviso de imagens bloqueadas sai do corpo (`withNotice`) e vai para a página, junto com os avisos de mensagem grande demais, de falha na formatação e de corpo ilegível. O CSS do e-mail pode esconder ou falsificar o que estiver dentro do iframe. Regra: tudo o que o webmail diz ao usuário fica fora do iframe; dentro dele, só o conteúdo do remetente. Teste: nenhum texto do webmail no documento da rota do corpo.
- **Ações (form actions):** marcar como lida ou não lida, e mover para arquivo, spam ou lixeira.
- **Busca:** formulário POST, só nas caixas permitidas.
- **Celular:** a lista e a leitura funcionam numa tela de 360 px.
- Tudo funciona **sem JavaScript**, com o `use:enhance` só melhorando a experiência.

### 5. Testes (PR 1 e PR 2)

**Corpus de ataques** (unitário, em `sanitize`), cada caso com o resultado esperado:

| Caso | Esperado |
|---|---|
| `<script>`, `<img onerror>`, `<body onload>` | Removidos |
| `<a href="javascript:...">`, `data:text/html`, `vbscript:` | Link vira texto |
| SVG com script, MathML | Removidos |
| `<form>`, `<input>`, `<button formaction>` | Removidos |
| `<base href>`, `<meta http-equiv="refresh">`, `<link>` | Removidos |
| `<iframe>`, `<object>`, `<embed>` | Removidos |
| `<style>` com `@import` ou `url(https://...)`, `style="background:url(...)"` | URL remota removida |
| Vetores conhecidos de mXSS (da documentação ou dos testes do DOMPurify) | Inofensivos |
| `<img src="https://rastreador/...">` | Removida e contada em `blockedImages` |
| Link `https://` normal | Mantido com `target="_blank"` e `rel="noopener noreferrer"` |

**HTTP, contra o build:**

| Caso | Esperado |
|---|---|
| Rota do corpo | CSP exata da decisão, `nosniff`, `no-store` |
| Outras páginas | `frame-ancestors 'none'`, sem `unsafe-inline` |
| Rota do corpo sem sessão | Redireciona para o login, sem conteúdo |
| Download de anexo declarado como `text/html` | `application/octet-stream`, `attachment`, `nosniff` |
| Nome de anexo com aspas, quebra de linha, `../` e acentos | `Content-Disposition` seguro |
| Mensagem de outra caixa (o Worker falso responde 404) | "Mensagem não encontrada", igual a inexistente |
| GET da página da mensagem | Não marca como lida |
| Busca | O termo nunca aparece na URL nem nos logs |
| HTML acima do limite | Mostra o texto e o botão do `.eml` |
| 3 sanitizações ao mesmo tempo | A terceira recebe 503 |

**No navegador (CI), com um e-mail malicioso do corpus:**
- Nenhum `dialog` (`alert`) é disparado.
- **Nenhuma requisição sai para fora de `localhost`**: o teste falha se o navegador tentar carregar qualquer endereço externo.
- O conteúdo do iframe não alcança a página do webmail (sem acesso a `parent.document`).
- Clicar num link do e-mail abre outra aba, sem `Referer`.

**Mutações:** desligar cada camada de segurança, uma de cada vez (o DOMPurify, a CSP da rota e o `sandbox` do iframe), e mostrar que algum teste falha em cada caso.

### 6. Teste real (depois do merge do PR 2)

Pelo `pnpm dev` em casa, com a minha conta real:
1. Abro as 7 mensagens que estão no D1 desde a Etapa 2, incluindo a que tem anexo de 18 MB.
2. Mando, de um Gmail, uma newsletter real com imagens. Confiro que as imagens aparecem bloqueadas e que o aviso aparece.
3. Marco como lida, movo para o arquivo e volto. Busco por um assunto.
4. Testo no celular, pelo túnel SSH.

### 7. Documentação

- `docs/webmail-leitura.md`: pesquisa, configuração do DOMPurify, as três camadas e por que a rota própria.
- `docs/decisoes.md`: três camadas, nenhum selo de verificado, nada que mude estado num GET, busca por POST.
- `docs/progresso.md`: ao fim de cada sessão. No "Depois": carregar imagens remotas (de preferência por um proxy, para não revelar o IP de quem lê), imagens `cid:` só de tipos raster conferidos pelo conteúdo do arquivo (nunca SVG), selo de remetente verificado com `Authentication-Results` confiável, mostrar o destino real do link antes de abrir e visão por conversa.

## Critérios de pronto

| Teste | Esperado |
|---|---|
| Corpus de ataques, testes HTTP e testes no navegador | Passam na CI |
| Mutações das três camadas | Cada uma derruba algum teste |
| Revisão independente do PR 1 | Feita, achados corrigidos ou aceitos por mim |
| Teste real (tarefa 6) | As 7 mensagens abrem; a newsletter aparece com as imagens bloqueadas |
| Celular | Lista e leitura usáveis em 360 px |
| `web-quality-audit` | Sem problema grave de acessibilidade |
| Dependências | Licenças compatíveis, cada uma justificada |
| `gitleaks` no histórico | Nenhum vazamento |
| `docs/progresso.md` | Etapa 6 concluída, próximo passo: Etapa 0-VPS e Etapa 7 |

## Ao terminar

1. Mostre como eu mesmo testo cada critério, passo a passo.
2. Liste as dependências adicionadas, a licença de cada uma e por que entrou.
3. Diga o que ficou pendente ou arriscado, principalmente o que a pesquisa não confirmou.
4. **Pare.** Não comece a Etapa 7.

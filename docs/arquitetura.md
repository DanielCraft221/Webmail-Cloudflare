# Arquitetura

Visão geral no [`README.md`](../README.md). Este documento descreve os fluxos e o papel de cada componente.

## Componentes

| Componente                   | Onde roda                       | Papel                                                                                     |
| ---------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| Cloudflare Email Routing     | Cloudflare                      | Recebe e-mail pelo MX dos domínios e entrega ao Worker                                    |
| Worker `mail-core`           | Cloudflare                      | Processa e guarda e-mails, expõe a API interna, envia respostas                           |
| Queues                       | Cloudflare                      | Fila `mail-ingest` entre o recebimento e o parse, com retries e DLQ `mail-ingest-dlq`     |
| R2                           | Cloudflare                      | `.eml` bruto, corpo parseado, anexos                                                      |
| D1                           | Cloudflare                      | Metadados, caixas, usuários, permissões. **Fonte da verdade**                             |
| Cloudflare Email Sending     | Cloudflare                      | Envio: binding do Worker (webmail) e SMTP (nLogin, NodeBB)                                |
| Cloudflare Tunnel            | Cloudflare + `cloudflared`      | Leva o tráfego do navegador ao servidor doméstico sem abrir portas                        |
| `webmail`                    | Servidor doméstico (Docker)     | Interface, login com 2FA, sessões. Guarda localmente só dados descartáveis (SQLite)       |
| nLogin, NodeBB               | Servidor doméstico              | Serviços de terceiros que enviam e-mails automáticos pelo SMTP da Cloudflare              |

## Fluxo de recebimento

1. Um remetente externo envia para `contato@survivus.com.br`.
2. O MX do domínio aponta para a Cloudflare. O Email Routing recebe a mensagem e, pela regra catch-all, entrega ao Worker `mail-core`.
3. **Handler `email`** (`apps/mail-core/src/email.ts`), curto e sem parse:
   1. Procura a caixa **ativa** do destinatário (em minúsculas) no D1. Não existe: `setReject("Unknown recipient")`.
   2. `rawSize` acima de 25 MiB: `setReject`.
   3. Lê o `raw` uma vez e calcula a chave de deduplicação: SHA-256 do `Message-ID` com os cabeçalhos `From`, `Date`, `Subject` e `To` normalizados. Sem `Message-ID`, SHA-256 do `.eml` inteiro. Se a chave já existe na caixa, a mensagem é uma duplicata: o `.eml` vai para `dup/AAAA/MM/<uuid>.eml` no R2, com os mesmos metadados, e não entra na fila. Nada é descartado.
   4. Grava o `.eml` em `raw/AAAA/MM/<uuid>.eml` no R2, com `customMetadata`: `mailboxId`, `envelopeTo`, `envelopeFrom`, `receivedAt` e `dedupeKey`. Com isso o R2 sozinho basta para reprocessar, mesmo com cópia oculta (o destinatário não aparece nos cabeçalhos).
   5. Envia para a fila `mail-ingest` só a chave e esses dados. Assunto e corpo não entram na fila.
4. **Consumidor da fila** (`apps/mail-core/src/ingest.ts`), uma mensagem por vez:
   1. Lê o `.eml` do R2 e faz o parse com `postal-mime`.
   2. Grava o corpo em `body/<uuid>.json` e cada anexo em `att/<uuid>/<uuid-do-anexo>`. O id do anexo é derivado do id da mensagem e da posição, então um retry reaproveita as mesmas chaves.
   3. Lê o `Authentication-Results` (veja abaixo). DMARC `fail` vai para a pasta `spam`.
   4. Grava a mensagem e os anexos no D1 num `batch` (tudo ou nada).

### O que acontece em cada falha

| Falha | Comportamento |
| ----- | ------------- |
| Destinatário inexistente ou mensagem grande demais | `setReject`: o remetente recebe o erro na hora |
| D1, R2 ou fila falham no handler | O handler lança a exceção. A Cloudflare responde ao remetente com **erro temporário**, e o servidor dele tenta de novo (medido no PR 2). **Nunca `setReject`** |
| A fila falha depois de gravar no R2 | Erro temporário, como acima. O `.eml` dessa tentativa fica no R2 sem linha no D1 |
| Parse falha (MIME quebrado) | A mensagem é registrada com `parse_status = 'failed'`, o assunto lido direto dos cabeçalhos e o `.eml` guardado |
| D1 ou R2 falham no consumidor | `retry` com espera de 30 s, dobrando até 1 h, por até 10 tentativas (cerca de 4 h). Depois vai para a DLQ `mail-ingest-dlq` |
| Mensagem na DLQ | Fica lá por 14 dias (sem consumidor). O `.eml` continua no R2 para sempre. Reprocessamento: em "Depois" no `progresso.md` |
| Duas entregas da mesma mensagem ao mesmo tempo | O índice único barra a segunda. O consumidor move o `.eml` dela para `dup/`, apaga o corpo e os anexos dela e confirma a mensagem da fila |
| Retry de uma mensagem que já tinha sido gravada | O consumidor reconhece o próprio id e só confirma |

### Autenticação (SPF, DKIM, DMARC)

O remetente pode colocar um `Authentication-Results` falso na mensagem. Por isso só vale o cabeçalho **do topo**, e só se o `authserv-id` dele estiver na lista `TRUSTED_AUTHSERV_IDS` (`apps/mail-core/src/auth-results.ts`), que tem `mx.cloudflare.net`. No SPF, vale o resultado do remetente do envelope (`smtp.mailfrom`), não o do HELO.

### Logs

Só o UUID da mensagem, a caixa, o domínio do remetente, o tamanho, o status, o nome do erro e, nas duplicatas, o hash da chave de deduplicação. Nunca assunto, corpo, nome de anexo nem endereço completo do remetente.

### Por que o servidor doméstico não fica no caminho de recebimento

Todo o recebimento acontece dentro da Cloudflare. O servidor doméstico só é usado para **ler**.

- Se o servidor cair (energia, internet, manutenção, falta de RAM por causa do Minecraft), **nenhum e-mail se perde**: tudo continua chegando no R2/D1.
- Não há porta 25 aberta em casa, nem IP residencial no MX (IPs residenciais costumam estar em listas de bloqueio).
- O servidor não precisa de alta disponibilidade.

## Fluxo de leitura

1. O navegador acessa `webmail.survivus.com.br`.
2. A Cloudflare encaminha pelo Tunnel até o `cloudflared`, que alcança o container `webmail` numa rede Docker exclusiva (sem portas publicadas).
3. O usuário faz login (senha argon2id + TOTP). A sessão fica no SQLite local.
4. O webmail chama a **API interna** do Worker (`docs/api.md`) por HTTPS, com o Service Token do Cloudflare Access e o Bearer token, informando o usuário.
5. O Worker verifica, **em toda rota**, se o usuário tem permissão sobre a caixa pedida, e responde com dados do D1/R2.
6. O webmail exibe o HTML da mensagem sanitizado (DOMPurify) dentro de `<iframe sandbox>`, sem scripts e com imagens remotas bloqueadas.

O webmail **nunca** acessa D1/R2 diretamente. Se o servidor for comprometido, o atacante tem só os segredos da API, que continuam sujeitos às verificações de permissão do Worker e ao rate limit.

O IP real do visitante vem do cabeçalho `CF-Connecting-IP`. Ele só é confiável porque apenas o `cloudflared` alcança o container. Por isso o Nginx não fica na frente do webmail.

## Fluxos de envio

### Respostas pelo webmail (Etapa 8)

Navegador → webmail → API do Worker → binding do Cloudflare Email Service. Remetentes: `contato@`, `suporte@`, `compras@` de cada domínio, conforme as permissões.

### Envio automático por serviços (Etapa 4)

nLogin e NodeBB **não passam por este projeto**. Eles falam direto com `smtp.mx.cloudflare.net:465` (TLS implícito), cada um com seu próprio token, enviando pelo subdomínio `mail.survivusmc.com`:

- nLogin → `nao-responda@mail.survivusmc.com`
- NodeBB → `forum@mail.survivusmc.com`

Riscos e mitigações em [`decisoes.md`](decisoes.md#envio-por-serviços-direto-pelo-smtp-da-cloudflare).

## Servidor doméstico

Debian 13, 16 GB de RAM, dividido entre o webmail, o servidor Minecraft (com nLogin) e o NodeBB. Todo container tem limite de memória e CPU no compose, para um serviço não derrubar os outros.

Redes Docker separadas:

- `webmail`: `cloudflared` + `webmail`
- `sites`: `cloudflared` + `nginx` (outros sites, fora deste repositório)

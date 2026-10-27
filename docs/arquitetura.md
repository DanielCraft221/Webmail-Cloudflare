# Arquitetura

Visão geral no [`README.md`](../README.md). Este documento descreve os fluxos e o papel de cada componente.

## Componentes

| Componente                   | Onde roda                       | Papel                                                                                     |
| ---------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| Cloudflare Email Routing     | Cloudflare                      | Recebe e-mail pelo MX dos domínios e entrega ao Worker                                    |
| Worker `mail-core`           | Cloudflare                      | Processa e guarda e-mails, expõe a API interna, envia respostas                           |
| R2                           | Cloudflare                      | `.eml` bruto, corpo parseado, anexos                                                      |
| D1                           | Cloudflare                      | Metadados, caixas, usuários, permissões. **Fonte da verdade**                             |
| Cloudflare Email Sending     | Cloudflare                      | Envio: binding do Worker (webmail) e SMTP (nLogin, NodeBB)                                |
| Cloudflare Tunnel            | Cloudflare + `cloudflared`      | Leva o tráfego do navegador ao servidor doméstico sem abrir portas                        |
| `webmail`                    | Servidor doméstico (Docker)     | Interface, login com 2FA, sessões. Guarda localmente só dados descartáveis (SQLite)       |
| nLogin, NodeBB               | Servidor doméstico              | Serviços de terceiros que enviam e-mails automáticos pelo SMTP da Cloudflare              |

## Fluxo de recebimento

1. Um remetente externo envia para `contato@survivus.com.br`.
2. O MX do domínio aponta para a Cloudflare. O Email Routing recebe a mensagem.
3. O Email Routing entrega a mensagem ao Worker `mail-core`.
4. O Worker guarda o `.eml` bruto no R2, faz o parse (`postal-mime`), guarda corpo e anexos no R2 e os metadados no D1.

### Por que o servidor doméstico não fica no caminho de recebimento

Todo o recebimento acontece dentro da Cloudflare. O servidor doméstico só é usado para **ler**.

- Se o servidor cair (energia, internet, manutenção, falta de RAM por causa do Minecraft), **nenhum e-mail se perde**: tudo continua chegando no R2/D1.
- Não há porta 25 aberta em casa, nem IP residencial no MX (IPs residenciais costumam estar em listas de bloqueio).
- O servidor não precisa de alta disponibilidade.

## Fluxo de leitura

1. O navegador acessa `webmail.survivus.com.br`.
2. A Cloudflare encaminha pelo Tunnel até o `cloudflared`, que alcança o container `webmail` numa rede Docker exclusiva (sem portas publicadas).
3. O usuário faz login (senha argon2id + TOTP). A sessão fica no SQLite local.
4. O webmail chama a **API interna** do Worker por HTTPS com Bearer token, informando o usuário.
5. O Worker verifica, **em toda rota**, se o usuário tem permissão sobre a caixa pedida, e responde com dados do D1/R2.
6. O webmail exibe o HTML da mensagem sanitizado (DOMPurify) dentro de `<iframe sandbox>`, sem scripts e com imagens remotas bloqueadas.

O webmail **nunca** acessa D1/R2 diretamente. Se o servidor for comprometido, o atacante tem só o token da API, que continua sujeito às verificações de permissão do Worker.

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

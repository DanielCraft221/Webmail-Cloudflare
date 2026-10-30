# Cloudflare Email Sending: pesquisa e configuração (Etapa 4)

Pesquisa da tarefa 1, feita em 2026-10-30 na documentação da Cloudflare. O Email Sending está em beta: confira de novo antes de mudar algo.

## O que o onboarding cria no DNS

Fonte: [Configure subdomains](https://developers.cloudflare.com/email-service/configuration/subdomains/) e [Domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/).

- Cada domínio ou subdomínio é ativado separadamente: **Compute › Email Service › Email Sending › Onboard Domain**.
- Para `mail.survivusmc.com`, o onboarding cria:

  | Nome | Tipo | Valor |
  |---|---|---|
  | `cf-bounce.mail.survivusmc.com` | MX | `route1/2/3.mx.cloudflare.net` (retorno de bounces) |
  | `cf-bounce.mail.survivusmc.com` | TXT | `v=spf1 include:_spf.mx.cloudflare.net ~all` |
  | `cf-bounce._domainkey.mail.survivusmc.com` | TXT | chave DKIM da Cloudflare |
  | `_dmarc.mail.survivusmc.com` | TXT | `v=DMARC1; p=reject;` (padrão da Cloudflare) |

- O SPF fica em `cf-bounce.mail…`, o domínio do envelope (Return-Path), e não em `mail.survivusmc.com` nem na raiz. Por isso não conflita com o SPF do Email Routing na raiz: um SPF por nome continua valendo.
- Os registros em `cf-bounce` ficam **travados** (*Locked*) enquanto o domínio estiver ativado. A documentação não diz se o `_dmarc` criado pelo onboarding também fica travado. **Conferir no painel.**
- **Remover o domínio do Email Sending** apaga os registros `cf-bounce` (MX, SPF e DKIM) e o DMARC que o onboarding criou, e para todo envio por ele. O Email Routing não é afetado: "Removing one does not affect the other."
- Limite: 30 domínios por zona, somando Email Routing e Email Sending.

## Cota

Fontes: [Limits](https://developers.cloudflare.com/email-service/platform/limits/) e [Pricing](https://developers.cloudflare.com/email-service/platform/pricing/).

- **Cota diária:** uma conta nova começa com uma cota diária "conservadora", que cresce com a reputação. **A documentação não diz o número nem onde ele aparece no painel.** Conferir na tela do Email Sending depois do onboarding. Para pedir aumento, há o formulário da página de limites.
- **Cota mensal:** o plano Workers Paid inclui 3.000 envios por mês. Depois disso, US$ 0,35 a cada 1.000.
- Até 50 destinatários por mensagem.
- **Endereços de destino verificados** (os do Email Routing): enviar para eles é grátis e não conta na cota. A página de limites diz que, nesse caso, só se envia "*from your routing domains*". **Não está claro se isso deixa um token enviar como um domínio que só tem Email Routing para um destino verificado.** O teste do remetente não ativado tem de usar um destinatário que **não** seja destino verificado.

## SMTP

Fonte: [SMTP](https://developers.cloudflare.com/email-service/api/send-emails/smtp/).

- `smtp.mx.cloudflare.net:465`, só TLS implícito. Sem 587/STARTTLS e sem 25.
- `AUTH PLAIN` ou `LOGIN`. Usuário `api_token`, senha = API token com *Email Sending: Edit* (account-owned é o recomendado).
- "*Anyone with it can send email from any onboarded domain on the matching account.*"
- Respostas que vamos testar:
  - `535 5.7.8`: token errado, expirado ou sem permissão;
  - `550 5.7.1 Sender denied`: o domínio do `MAIL FROM` não está ativado no Email Sending.
- Mensagem de até 25 MiB, até 50 `RCPT TO` por sessão.
- **Atenção:** o exemplo da documentação põe o token em `--user` na linha de comando, o que o deixa visível no `ps`. O `scripts/smtp-test.sh` passa a credencial ao `curl` por um arquivo de configuração lido de um descritor (`-K`), nunca por argumento.

## DMARC

Fontes: [DMARC Management](https://developers.cloudflare.com/dmarc-management/) e [Enable DMARC Management](https://developers.cloudflare.com/dmarc-management/enable/).

- **DMARC Management:**
  - gratuito, disponível em todos os planos com DNS na Cloudflare;
  - fica em **Email › DMARC Management** na zona;
  - acrescenta ao `_dmarc` um `rua=mailto:<id>@dmarc-reports.cloudflare.net` e mostra os relatórios no painel;
  - **funciona só no domínio apex** (`survivusmc.com`). Para o subdomínio, o caminho é ter o mesmo `rua` no `_dmarc.mail.survivusmc.com`.
- **Política inicial para `mail.survivusmc.com`:** `p=none` com o `rua` da Cloudflare, para ler os relatórios sem bloquear nada. O padrão do onboarding é `p=reject`. Endurecer para `quarantine`/`reject` quando os relatórios mostrarem só envios legítimos.
- **Alinhamento:** o From é `@mail.survivusmc.com` e o envelope é `cf-bounce.mail.survivusmc.com`. No alinhamento relaxado (o padrão), os dois têm o mesmo domínio organizacional (`survivusmc.com`), então o SPF alinha. O DKIM alinha se o `d=` for `mail.survivusmc.com` ou um subdomínio dele. **Conferir nos cabeçalhos do teste real.**

## Drop suppressed recipients

Fontes: [Domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/#drop-suppressed-recipients) e [Suppression lists](https://developers.cloudflare.com/email-service/concepts/suppressions/).

- **Desligado (padrão):** uma mensagem com destinatário suprimido (bounce ou reclamação de spam) é **recusada**. O SMTP devolve erro.
- **Ligado:** os suprimidos são removidos e o resto é enviado. Se **todos** forem suprimidos, o SMTP pode responder `250 2.0.0 Ok` sem entregar nada.
- **No nosso caso** (nLogin e NodeBB mandam um destinatário por mensagem), deixar **desligado**: a falha aparece como erro no serviço, e o envio não "dá certo" em silêncio.
- Supressões automáticas:
  - hard bounce: 7 dias, ou sem prazo se a caixa não existir;
  - soft bounce: 24 h;
  - reclamação de spam: sem prazo.

## Logs de entrega

Fonte: [Activity log](https://developers.cloudflare.com/email-service/observability/logs/).

- Ficam em **Compute › Email Service › Activity log**, com filtro de 30 minutos a 30 dias.
- Estados: `Sent`, `Delivered`, `Delivery failed`, `Rejected` (suprimido) e `Failed`.
- Cada envio mostra SPF, DKIM e DMARC, a resposta do servidor de destino e uma prévia da mensagem com os cabeçalhos.
- Os mesmos dados estão na GraphQL Analytics API (`emailSendingAdaptive`).

## Estado encontrado em 2026-10-30 (`dig`, só leitura)

| Nome | Registro encontrado | Esperado pela etapa |
|---|---|---|
| `survivusmc.com` | MX `route1/2/3.mx.cloudflare.net` e SPF `include:_spf.mx.cloudflare.net` (**Email Routing ligado**) | Sem Email Routing |
| `_dmarc.survivusmc.com` | `p=reject` com `rua` da Cloudflare (**DMARC Management ligado**) | — |
| `mail.survivusmc.com` | `cf-bounce` MX, SPF e DKIM, e `_dmarc` `p=reject` com `rua` (**já ativado no Email Sending**) | Ainda não ativado |
| `survivus.com.br` | `cf-bounce` MX, SPF e DKIM (**ativado no Email Sending**), além do Email Routing da Etapa 2 | **Não** ativado |
| `dirdistribuidora.com.br` | nenhum registro de e-mail | — |

A confirmação de quais domínios estão ativados tem de vir do painel ou da API (tarefa 2). O DNS só indica.

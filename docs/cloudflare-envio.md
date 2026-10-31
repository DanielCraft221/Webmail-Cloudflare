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

- **Cota diária:** uma conta nova começa com uma cota diária "conservadora", que cresce com a reputação. A documentação não diz o número. **Nesta conta: 200 por dia** (painel, **Compute › Email Service › Email Sending**, conferido em 2026-10-31). A cota vale para a **conta inteira**: nLogin, NodeBB e, a partir da Etapa 8, o webmail dividem os mesmos 200. Para pedir aumento, há o formulário da página de limites.
- **Cota mensal:** o plano Workers Paid inclui 3.000 envios por mês. Depois disso, US$ 0,35 a cada 1.000.
- Até 50 destinatários por mensagem.
- **Endereços de destino verificados** (os do Email Routing): enviar para eles é grátis e não conta na cota. A página de limites diz que, nesse caso, só se envia "*from your routing domains*". **Testado em 2026-10-30:** `contato@survivus.com.br` (só Email Routing, sem Email Sending) para o Gmail, destino verificado, foi recusado com `550`. Ter Email Routing não basta para enviar.

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
- **Política de `mail.survivusmc.com`:** a pesquisa sugeria começar com `p=none`. Decidido manter o `p=reject` do onboarding, com o `rua` da Cloudflare (`docs/decisoes.md`).
- **Alinhamento:** o From é `@mail.survivusmc.com` e o envelope é `cf-bounce.mail.survivusmc.com`. No alinhamento relaxado (o padrão), os dois têm o mesmo domínio organizacional (`survivusmc.com`), então o SPF alinha. O DKIM alinha se o `d=` for `mail.survivusmc.com` ou um subdomínio dele. **Conferido no teste real:** veja "Resultado dos testes".

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
- Cada envio mostra SPF, DKIM e DMARC e a resposta do servidor de destino. O conteúdo da mensagem só aparece com o *Email preview* ligado (abaixo).
- Os mesmos dados estão na GraphQL Analytics API (`emailSendingAdaptive`).

## Email preview

Fonte: [changelog de 2026-07-17](https://developers.cloudflare.com/changelog/post/2026-07-17-email-message-preview/).

- Mostra no Activity log o conteúdo completo das mensagens enviadas: HTML, texto, cabeçalhos, anexos e o código-fonte.
- A Cloudflare **guarda esse conteúdo por cerca de 7 dias**. Para o nLogin, isso inclui os códigos de recuperação.
- Fica nas configurações de cada domínio de envio. Domínios ativados a partir de 2026-07-02 já vêm com ele **ligado**.
- **Nosso uso: desligado.** Para depurar, ligue por pouco tempo e desligue depois. Só os envios feitos com ele ligado ficam guardados.
- Desligado, o Activity log continua mostrando o status de cada envio.

## Estado depois da Etapa 4 (2026-10-31)

Domínios ativados no Email Sending (painel): **só `mail.survivusmc.com`**. O `survivus.com.br` estava ativado de uma tentativa antiga e foi removido em 2026-10-30. Isso apagou os registros `cf-bounce` dele e não afetou o Email Routing.

DNS (`dig`, valores de chave e `rua` encurtados):

| Nome | Registro |
|---|---|
| `cf-bounce.mail.survivusmc.com` | MX `route1/2/3.mx.cloudflare.net` e SPF `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| `cf-bounce._domainkey.mail.survivusmc.com` | DKIM (`k=rsa`) |
| `_dmarc.mail.survivusmc.com` | `v=DMARC1; p=reject; rua=mailto:<id>@dmarc-reports.cloudflare.net;` |
| `mail.survivusmc.com` | nenhum MX nem TXT. Resposta a `nao-responda@` volta como bounce |
| `survivusmc.com` | MX e SPF do Email Routing (catch-all para o `mail-core`, Etapa 11) |
| `_dmarc.survivusmc.com` | `p=reject; sp=reject` com o mesmo `rua` |
| `survivus.com.br` | MX, SPF e `cf2024-1._domainkey` do Email Routing (**não apagar**). Nenhum `cf-bounce` |
| `_dmarc.survivus.com.br` | `p=reject; sp=reject` com `rua` |

Um único SPF por nome em todos.

Configurações de `mail.survivusmc.com`:

- **Drop suppressed recipients: desligado.** Ligado, uma mensagem com um único destinatário suprimido pode receber `250` sem ser entregue: uma falha silenciosa.
- **Email preview: desligado** (conferido no painel em 2026-10-31). Ligado, ele guarda o conteúdo completo dos e-mails por cerca de 7 dias. Para depurar, ligue por pouco tempo e desligue depois. O Activity log continua mostrando o status.

## Resultado dos testes (2026-10-30 e 2026-10-31)

Com `scripts/smtp-test.sh` e tokens temporários (`smtp-teste`, `smtp-teste-2`), os dois já revogados.

| Teste | Resultado |
|---|---|
| `nao-responda@mail.survivusmc.com` → Gmail | `250`. Caixa de entrada. Pode ter influído Daniel ter marcado "Não é spam": vale só para a conta dele |
| O mesmo → Outlook | `250`. **Lixo eletrônico** (`SCL:5`, `RF:JunkEmail`), mesmo com tudo `pass` |
| Cabeçalhos (Gmail e Outlook) | SPF `pass` (`smtp.mailfrom=…@cf-bounce.mail.survivusmc.com`), DKIM `pass` com `d=mail.survivusmc.com` (seletor `cf-bounce`) e `d=cloudflare-smtp.org` (`cf2024-1`), DMARC `pass` alinhado em `mail.survivusmc.com` |
| `contato@survivus.com.br` → Gmail e → Outlook | `550` |
| `contato@survivusmc.com` (domínio principal, não ativado) → Gmail | `550`. O alinhamento relaxado não importa enquanto o domínio principal não estiver ativado |
| Token errado ou revogado | `535` (`curl: (67) Login denied`) |
| Activity log | Os envios aparecem como entregues |

Cabeçalhos gerados:

- `Date` e `MIME-Version` vêm do script e chegam como foram enviados.
- `Message-ID`: a Cloudflare **substitui** qualquer `Message-ID` pelo dela (`<…@mail.survivusmc.com>`). Por isso o script não gera um.
- A Cloudflare acrescenta `Feedback-ID: survivusmc.com:…:Cloudflare`.

## Pendências e riscos

- **Outlook no lixo:** afeta o código de recuperação do nLogin. O teste com uma recuperação real está em `docs/smtp-servicos.md`.
- **Cota de 200 por dia para a conta inteira:** um serviço em loop, ou alguém pedindo recuperação de senha sem parar, gasta a cota de todos. Veja o cooldown do nLogin em `docs/smtp-servicos.md` e o relay interno em `docs/progresso.md` ("Depois").
- **`mail.survivusmc.com` sem MX:** quem responder a `nao-responda@` recebe bounce. É o esperado para um remetente que não recebe.
- **Catch-all de `survivusmc.com` para o `mail-core`:** fica para a Etapa 11.

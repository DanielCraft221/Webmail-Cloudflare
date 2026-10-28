# Cloudflare Email Routing: pesquisa (Etapa 2)

Pesquisa feita em 2026-10-27 na documentação oficial (repositório `cloudflare/cloudflare-docs`, branch `production`). A documentação de Email Routing agora fica dentro de **Email Service** (`/email-service/`). O Email Service está em beta: confira de novo antes de mudar o código.

## Handler `email(message, env, ctx)`

Fonte: [Email Service › Workers API (route emails)](https://developers.cloudflare.com/email-service/api/route-emails/email-handler/)

O `message` é um `ForwardableEmailMessage`:

| Campo / método | Tipo | Observação |
| --- | --- | --- |
| `from` | `string` | Remetente do envelope (`MAIL FROM`) |
| `to` | `string` | Destinatário do envelope (`RCPT TO`) |
| `headers` | `Headers` | Cabeçalhos da mensagem. Cabeçalhos repetidos são juntados num valor só, separados por vírgula |
| `raw` | `ReadableStream` | MIME bruto |
| `rawSize` | `number` | Tamanho em bytes |
| `setReject(reason)` | `void` | Recusa com **erro SMTP permanente** |
| `forward(rcptTo, headers?)` | `Promise` | Encaminha para um endereço de destino **verificado** |
| `reply(message)` | `Promise` | Resposta, com restrições (DMARC válido, uma vez por evento) |

- O `raw` é um stream: só pode ser lido uma vez. Os exemplos oficiais leem com `await new Response(message.raw).arrayBuffer()` e fazem o parse a partir do buffer.
- A documentação recomenda `postal-mime` para o parse.

## Exceção no handler: **não documentado**

- Nenhuma página diz o que o remetente recebe quando o handler lança uma exceção: erro temporário (4xx), erro permanente (5xx) ou mensagem descartada.
- O exemplo oficial de "Error handling" termina em `setReject("Internal processing error")`, que é recusa permanente. Este projeto **não** segue esse exemplo, porque erro interno nunca vira `setReject`.
- Não existe método de "falha temporária" no `ForwardableEmailMessage`. Um [tópico da comunidade](https://community.cloudflare.com/t/is-it-possible-to-return-a-transient-failure-from-an-email-worker/599938) (antigo) pede exatamente isso e conclui que a API só oferece a recusa permanente.
- **Medido no PR 2 (2026-10-28):** a exceção vira **falha temporária**. O Registro de atividade mostrou "upstream (worker:mail-test-scratch) temporary error: worker script threw an exception", e o Gmail tentou de novo 7 vezes em cerca de 4 h. Detalhes em `decisoes.md`.
- **Plano adotado:** o handler faz o mínimo (valida, deduplica, grava o `.eml` no R2 e manda a chave para uma fila). Em erro interno, relança a exceção. Nunca `setReject`.

## Cabeçalhos de autenticação na entrada: **não documentado**

- A página [Headers](https://developers.cloudflare.com/email-service/reference/headers/) trata só do **envio**: lista `ARC-*`, `DKIM-Signature` e outros cabeçalhos que a Cloudflare gera ao enviar.
- Nada documenta quais cabeçalhos o Email Routing acrescenta numa mensagem recebida (`Authentication-Results`, `ARC-Authentication-Results`, `Received-SPF`) nem o formato deles.
- **Risco:** um remetente pode incluir o próprio `Authentication-Results` falso (ex.: `dmarc=pass`). Só vale o cabeçalho acrescentado pela Cloudflare, que é o primeiro de cima para baixo e tem o identificador do servidor da Cloudflare. Como `message.headers.get()` junta os cabeçalhos repetidos, a leitura usa a lista ordenada de cabeçalhos do `postal-mime`.
- **Plano adotado:** ler só o primeiro `Authentication-Results` (RFC 8601), e só se o `authserv-id` estiver em `TRUSTED_AUTHSERV_IDS`.
- **Medido no PR 2 (2026-10-28), numa mensagem real do Gmail:** o primeiro `Authentication-Results` vem logo abaixo do `Received` da Cloudflare, com `authserv-id` `mx.cloudflare.net`. Formato (valores trocados):

  ```
  Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.net header.s=sel1 header.b=...;
    dmarc=pass header.from=example.net policy.dmarc=quarantine;
    spf=none (...) smtp.helo=mail-out.example.net; spf=pass (...) smtp.mailfrom=example.net;
    arc=pass smtp.remote-ip=192.0.2.10
  ```

  São dois resultados de SPF: o do HELO e o do remetente do envelope. O código usa o de `smtp.mailfrom`. A Cloudflare também acrescenta `Received-SPF`, `ARC-Seal` e `ARC-Message-Signature` (`d=cloudflare-email.net`) e `ARC-Authentication-Results`.

## Limites

| Limite | Valor | Fonte |
| --- | --- | --- |
| Tamanho máximo da mensagem recebida | 25 MiB (maiores são recusadas pelo próprio Email Routing) | [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/) |
| Regras por domínio | 200 | idem |
| CPU do Worker (plano pago) | até 5 min; padrão 30 s por invocação HTTP. O valor para o handler `email` não está explícito | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Memória do Worker | 128 MB (Free e Paid) | idem |
| Plano Free | Handlers de e-mail complexos podem falhar com `EXCEEDED_CPU` (10 ms) | [Email Service limits](https://developers.cloudflare.com/email-service/platform/limits/) |

Esperar o R2 ou o D1 não conta como CPU. O parse de uma mensagem grande conta.

**Memória:** uma mensagem de 25 MiB fica no buffer, e o `postal-mime` cria cópias decodificadas dos anexos. O total pode passar de 70 MB, perto do limite de 128 MB. O código descarta referências cedo. Medido no PR 2: veja "Testes reais".

## Wrangler, D1 e R2

- **Configuração:** a Cloudflare recomenda `wrangler.jsonc` para projetos novos ([Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)). O `account_id` pode vir da variável `CLOUDFLARE_ACCOUNT_ID`. `workers_dev` e `preview_urls` são booleanos opcionais.
- **Tipos:** `wrangler types` gera os tipos dos bindings, então não precisa do pacote `@cloudflare/workers-types`.
- **Migrações do D1:** arquivos `.sql` em `migrations/` (`migrations_dir`), aplicados com `wrangler d1 migrations apply <banco> --local|--remote`. As migrações aplicadas ficam registradas na tabela `d1_migrations` ([D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)).
- **Lote:** `DB.batch([...])` é uma transação SQL. Se um comando falha, o lote inteiro é desfeito ([D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)).
- **R2:** buckets nunca são públicos por padrão. O acesso público e o `r2.dev` exigem ativação explícita ([Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)).

## Queues

Fontes: [Limits](https://developers.cloudflare.com/queues/platform/limits/), [Batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/), [Dead letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)

| Item | Valor |
| --- | --- |
| Tamanho máximo de uma mensagem da fila | 128 KB. Por isso a fila leva só a chave do R2, nunca o `.eml` |
| Retenção | Configurável até 14 dias no plano pago (24 h fixas no Free) |
| `max_retries` | Padrão 3, máximo 100. Este projeto usa 10 |
| CPU do consumidor | 30 s por padrão, até 5 min com `limits.cpu_ms`. Tempo total: 15 min |
| DLQ sem consumidor | As mensagens ficam pela retenção da fila (padrão **4 dias**) e depois são apagadas. As filas deste projeto foram criadas com 14 dias |

- Se o `queue()` lança exceção, o lote inteiro volta, menos as mensagens já confirmadas com `ack()`. `msg.retry({ delaySeconds })` devolve uma mensagem com espera.
- Não existe espera crescente automática. O código calcula a partir de `msg.attempts`: 30 s, dobrando, até 1 h.
- Se a DLQ indicada em `dead_letter_queue` não existir, a Cloudflare cria sozinha.
- Testes: `createMessageBatch()` e `getQueueResult()` (do `cloudflare:test`) mostram o ack ou retry de cada mensagem.

## Metadados do R2

O total de metadados de um objeto é de 8.192 bytes ([R2 limits](https://developers.cloudflare.com/r2/platform/limits/)). O `customMetadata` do `.eml` cabe com folga, porque a chave de deduplicação é sempre um hash SHA-256. A documentação não diz se aceita caracteres fora do ASCII (endereços SMTPUTF8): se a gravação falhar, o handler lança a exceção (falha temporária).

## Testes com Vitest

- O pacote atual é **`@cloudflare/vitest-plugin`**, com o plugin `cloudflareTest()` no `vitest.config.ts`. O antigo `@cloudflare/vitest-pool-workers` tem guia de migração ([Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/)).
- `readD1Migrations()` e `applyD1Migrations()` aplicam as migrações no D1 local dos testes.
- A documentação não tem helper para o handler `email`. O teste chama `worker.email(mensagemFalsa, env, ctx)` com um objeto que imita o `ForwardableEmailMessage`.
- Para teste manual, o `wrangler dev` aceita `POST /cdn-cgi/local/email` com uma mensagem RFC 5322, que precisa ter `Message-ID` ([Test email routing locally](https://developers.cloudflare.com/email-service/observability/local-development/routing/)).

## Testes reais (PR 2, 2026-10-28)

| Teste | Resultado |
| --- | --- |
| Gmail para `contato@` com anexo de 2,14 MB | Passou: `.eml`, corpo e anexo no R2, linha no D1 com `parse_status = ok` |
| Gmail para endereço inexistente | Passou: `555 5.7.1 Unknown recipient`, nada gravado |
| `authserv-id` real | `mx.cloudflare.net` (formato acima). Achado: dois resultados de SPF, corrigido no código |
| `forward()` depois de ler o `raw` | Funcionou (Worker descartável). O encaminhamento de reserva foi removido depois, então isso não é mais usado |
| Exceção no handler | Falha temporária, o remetente tenta de novo (acima e em `decisoes.md`) |
| Autenticação depois do deploy do PR 2b | Mensagem do Gmail com `spf`, `dkim` e `dmarc` = `pass` no D1 |
| Memória: `.eml` de 16.740.588 bytes (16,7 MB), anexo `video/mp4` de 12.227.425 bytes | Passou: consumidor na 1ª tentativa, sem erro, tamanhos iguais no R2 e no D1 |
| Memória, pior caso: `.eml` de 25.956.255 bytes (24,75 MiB, perto do limite de 25 MiB), anexo `video/mp4` de 18.962.423 bytes | Passou: consumidor na 1ª tentativa, sem "Exceeded Memory Limit" nem outro erro, tamanhos iguais no R2 e no D1 |

**Ressalva dos testes de memória:** o `wrangler tail` não mostra quanta memória o Worker usou. Os testes provam que essas mensagens couberam no limite de 128 MB, não a folga que sobrou.

Pendentes:

1. **`Authentication-Results` forjado com o `authserv-id` da Cloudflare:** pelo Gmail não dá para testar se a Cloudflare remove ou renomeia esse cabeçalho (RFC 8601, seção 5). Veja o reforço previsto antes da Etapa 6 em `decisoes.md`.
2. **Workers Logs sem o remetente completo:** conferir no painel que nenhuma entrada guardada tem o `mailFrom` (os *invocation logs* estão desligados no `wrangler.jsonc`).

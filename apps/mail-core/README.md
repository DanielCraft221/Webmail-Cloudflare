# mail-core

Cloudflare Worker que é o núcleo do webmail.

- **Recebimento** (Etapa 2, código pronto, ainda sem deploy): o handler `email` valida o destinatário e o tamanho, deduplica, grava o `.eml` no R2 e manda a chave para a fila `mail-ingest`. O consumidor da fila faz o parse, grava corpo e anexos no R2 e os metadados no D1. Detalhes e comportamento em cada falha em [`docs/arquitetura.md`](../../docs/arquitetura.md#fluxo-de-recebimento).
- **API interna de leitura** (Etapa 3): HTTPS com Bearer token, usada só pelo webmail. Hoje o `fetch` responde 404 para tudo.
- **Envio** (Etapa 8): respostas do webmail pelo binding do Cloudflare Email Service.

| Pasta / arquivo | Conteúdo |
| --- | --- |
| `src/email.ts` | Handler `email` e encaminhamento de reserva |
| `src/ingest.ts` | Consumidor da fila: parse, R2, D1, retries |
| `src/auth-results.ts` | Leitura do `Authentication-Results` confiável |
| `migrations/` | Migrações do D1 |
| `seed/` | Dados iniciais (domínio e caixas) |
| `test/` | Testes (Vitest no runtime do Workers) e mensagens `.eml` inventadas |
| `worker-configuration.d.ts` | Gerado por `pnpm types` (`wrangler types`). Não edite à mão |

Stack: Hono, `postal-mime`, Cloudflare Queues, testes com `@cloudflare/vitest-plugin`.

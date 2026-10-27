# mail-core

Cloudflare Worker que é o núcleo do webmail. **Ainda sem código.**

Vai conter:

- **Recebimento** (Etapa 2): recebe os e-mails do Cloudflare Email Routing, guarda o `.eml` bruto, o corpo parseado e os anexos no R2, e os metadados no D1.
- **API interna de leitura** (Etapa 3): HTTPS com Bearer token, usada só pelo webmail. Verifica a permissão do usuário sobre a caixa em toda rota.
- **Envio** (Etapa 8): respostas do webmail pelo binding do Cloudflare Email Service.

Stack prevista: Hono, `postal-mime`, testes com `@cloudflare/vitest-pool-workers`.

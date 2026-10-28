# webmail-cloudflare

Webmail próprio para poucos usuários, acessado só pelo navegador, construído sobre o **Cloudflare Email Service** (Email Routing para receber, Email Sending para enviar), um Worker com R2 + D1 e uma interface SvelteKit rodando num servidor doméstico atrás de um Cloudflare Tunnel.

Sem IMAP, sem POP3, sem servidor SMTP próprio.

> **Projeto pessoal em desenvolvimento.** Ainda não faz nada útil. Não use em produção.

## Arquitetura

```
Internet ──MX──> Cloudflare Email Routing ──> Worker "mail-core" (apps/mail-core)
                                                ├─ email(): valida, deduplica, grava .eml no R2, envia a chave para a fila
                                                │     └─ falha no R2, na fila ou no D1: exceção = erro temporário, o remetente tenta de novo (nunca setReject)
                                                ├─ Queue "mail-ingest" ──> queue(): parse, anexos no R2, metadados no D1
                                                │     └─ retries com espera crescente; esgotados: DLQ "mail-ingest-dlq"
                                                ├─ R2: .eml bruto, corpo parseado, anexos
                                                ├─ D1: metadados, caixas, usuários, permissões (fonte da verdade)
                                                ├─ Envio: binding do Cloudflare Email Service
                                                └─ API interna HTTPS (Bearer token) ─ usada só pelo webmail
                                                        ▲
nLogin / NodeBB ──SMTP 465 (um token cada)──> smtp.mx.cloudflare.net (não passa por este projeto)
                                                        ▲
Navegador ─> Cloudflare ─> Tunnel ─> [Servidor Debian 13, Docker]
                                      ├─ rede "webmail": cloudflared + webmail (SvelteKit/Node)
                                      └─ rede "sites":   cloudflared + nginx (outros sites, fora deste repo)
```

Detalhes em [`docs/arquitetura.md`](docs/arquitetura.md) e decisões em [`docs/decisoes.md`](docs/decisoes.md).

## Estrutura

| Pasta             | Conteúdo                                         |
| ----------------- | ------------------------------------------------ |
| `apps/mail-core`  | Cloudflare Worker: recebimento, API, envio       |
| `apps/webmail`    | Interface web (SvelteKit + Node, em container)   |
| `packages/shared` | Tipos e schemas `zod` compartilhados             |
| `docs/`           | Arquitetura, decisões, segredos, progresso       |

## Desenvolvimento

Requer Node 24 LTS e pnpm 12.

```sh
pnpm install     # instala dependências e o hook de pre-commit (lefthook + gitleaks)
pnpm lint        # Biome
pnpm typecheck   # TypeScript em todos os pacotes
pnpm test        # Vitest em todos os pacotes
```

O hook de pre-commit exige o [gitleaks](https://github.com/gitleaks/gitleaks) instalado no `PATH`.

## Status

| Etapa | Conteúdo                                                        | Status       |
| ----- | --------------------------------------------------------------- | ------------ |
| 0     | Preparação manual do servidor                                   | Concluída    |
| 1     | Repositório, monorepo, lint, testes, CI, gitleaks, documentação | Concluída    |
| 2     | Worker: recebimento de e-mails → R2 + D1                        | Em andamento |
| 3     | Worker: API interna de leitura com verificação de permissão     | Pendente     |
| 4     | Envio para serviços (nLogin, NodeBB) via `mail.survivusmc.com`  | Pendente     |
| 5     | Webmail: login, 2FA, sessões, rate limit, IP ban, CLI de admin  | Pendente     |
| 6     | Webmail: caixas, lista e leitura com HTML sanitizado            | Pendente     |
| 7     | Docker Compose + Cloudflare Tunnel                              | Pendente     |
| 8     | Envio e resposta pelo webmail                                   | Pendente     |
| 9     | Múltiplos usuários e permissões por caixa                       | Pendente     |
| 10    | Painel de administração em `/admin`                             | Pendente     |
| 11    | Domínio `survivusmc.com`                                        | Pendente     |
| 12    | Domínio `dirdistribuidora.com.br`                               | Pendente     |

## Segurança

Veja [`SECURITY.md`](SECURITY.md) para reportar vulnerabilidades e [`docs/segredos.md`](docs/segredos.md) para a política de segredos.

## Licença

[AGPL-3.0-only](LICENSE).

Você pode usar, modificar e redistribuir este código. Se você rodar uma **versão modificada como serviço** acessível pela rede, precisa oferecer o código-fonte dessa versão aos usuários do serviço, sob a mesma licença. Por isso o webmail terá um link para o código-fonte no rodapé.

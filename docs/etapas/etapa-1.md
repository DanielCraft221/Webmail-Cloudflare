# Etapa 1: Repositório, monorepo, CI e proteção contra vazamento de segredos

> Pré-requisito: a Etapa 0 está validada (Claude Code instalado, `~/Survivus/Projetos/Webmail-Cloudflare` clonado do GitHub, Node e pnpm funcionando).
> As regras permanentes estão em `CLAUDE.md`. Siga-as durante toda a etapa.

## Objetivo

Deixar o repositório pronto para receber código com segurança: estrutura do monorepo, ferramentas de qualidade, testes, CI no GitHub e **bloqueio automático de segredos** antes de qualquer commit. Nenhuma funcionalidade de e-mail é feita nesta etapa.

## Antes de começar

1. Confirme que você está em `~/Survivus/Projetos/Webmail-Cloudflare` e que `git remote -v` aponta para `git@github.com:DanielCraft221/Webmail-Cloudflare.git`.
2. Mova este arquivo para `docs/etapas/etapa-1.md`. O `CLAUDE.md` fica na raiz.
3. Confirme que `git config user.email` é o endereço **noreply do GitHub** (`...@users.noreply.github.com`). Se não for, pare e me avise **antes do primeiro commit**: um e-mail errado fica para sempre no histórico público.
4. A licença já está decidida: **AGPL-3.0**.
5. Apresente o plano da etapa em tópicos curtos e **espere minha aprovação**.

## Tarefas

### 1. Proteção de segredos (fazer primeiro, antes de qualquer outro commit)

- Crie o `.gitignore` cobrindo no mínimo: `node_modules/`, `.env`, `.env.*` (exceto `.env.example`), `.dev.vars`, `*.pem`, `*.key`, `.wrangler/`, `*.db`, `*.db-*`, `*.sqlite*`, `dist/`, `build/`, `.svelte-kit/`, `coverage/`, `*.log`, `.DS_Store`.
- Crie o `.dockerignore` na raiz com as mesmas exclusões de segredos e lixo de build, mais `.git/`. Explique por que o `.gitignore` não protege a imagem Docker.
- Crie o `.env.example` na raiz **apenas com nomes e valores falsos**, comentados. Ele documenta o formato, não guarda nada real.
- Instale o **gitleaks** no servidor:
  - Se o pacote do Debian 13 tiver uma versão recente (8.x), use `apt`.
  - Se não tiver, use o binário oficial do GitHub (gitleaks/gitleaks), **conferindo o checksum**, instalado em `/usr/local/bin`.
  - Comandos com `sudo`: mostre e espere meu ok.
- Configure um **hook de pre-commit** que roda o gitleaks nos arquivos staged. Use `lefthook` (dependência de desenvolvimento) para o hook ser versionado e instalado automaticamente no `pnpm install`. Confira a sintaxe atual do gitleaks para pre-commit (a CLI mudou entre versões).
- Crie `.gitleaks.toml` estendendo as regras padrão. Só adicione allowlist se for realmente necessário, e explique o motivo.
- **Teste de verdade:** crie um arquivo temporário com um token falso que bata com uma regra do gitleaks, tente commitar, mostre que o commit foi **bloqueado**, depois apague o arquivo. Nada disso pode chegar ao histórico.

### 2. Monorepo

- `package.json` na raiz com `"private": true`, `packageManager` (versão do pnpm instalada) e `engines.node` (versão LTS instalada).
- `pnpm-workspace.yaml` com `apps/*` e `packages/*`.
- Proteções de cadeia de suprimentos do pnpm, se a versão instalada suportar: `minimumReleaseAge` (ex.: 7 dias, para evitar pacotes recém-publicados e comprometidos) e manter scripts de instalação bloqueados, liberando só os necessários (`onlyBuiltDependencies`). Explique cada configuração para mim.
- `.npmrc` sem nenhum token.
- `.editorconfig` e `.gitattributes` (LF em tudo).
- `tsconfig.base.json` com `strict: true`, `noUncheckedIndexedAccess: true` e `module`/`moduleResolution` modernos. Cada pacote estende esse arquivo.

### 3. Pacote `packages/shared` (o único com código nesta etapa)

- Nome `@webmail/shared`, com `zod`.
- Um schema de exemplo **útil para o projeto**, por exemplo um validador de endereço de caixa (`MailboxAddress`) que aceita apenas os domínios configurados.
- Testes com Vitest cobrindo casos válidos e inválidos.
- Serve para provar que lint, typecheck, testes e CI funcionam de ponta a ponta.

### 4. Pastas `apps/mail-core` e `apps/webmail`

- **Não crie código nem scaffolding ainda** (o Worker é da Etapa 2, o webmail da Etapa 5).
- Apenas um `README.md` em cada uma, em português, descrevendo o que a pasta vai conter e em qual etapa.

### 5. Qualidade de código

- **Biome** para lint e formatação, configurado na raiz.
- Scripts na raiz: `lint`, `format`, `typecheck`, `test`. Use `pnpm -r` ou `--filter` para rodar em todos os pacotes.
- O hook de pre-commit também roda `biome check` nos arquivos staged (rápido). Typecheck e testes ficam no CI.

### 6. CI no GitHub Actions (`.github/workflows/ci.yml`)

- Roda em `push` para `main` e em todo `pull_request`.
- `permissions: contents: read` (mínimo necessário).
- Actions com **versão fixa**: preferencialmente o SHA do commit, com a versão em comentário.
- Jobs:
  - **secrets:** gitleaks no **histórico completo** (`fetch-depth: 0`). Use o binário ou a imagem Docker oficial com versão fixa. A conta é pessoal, então a action oficial também serve, sem licença.
  - **quality:** `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- Cache do pnpm.
- `.github/dependabot.yml`: atualizações semanais para `github-actions` e `npm`, agrupadas, para não gerar dezenas de PRs.

### 7. Documentação (em português)

- `README.md`: o que é o projeto, diagrama da arquitetura (copie do `CLAUDE.md`), aviso de que é um projeto pessoal em desenvolvimento e uma tabela de status das etapas.
- `docs/arquitetura.md`: fluxo de recebimento, leitura e envio; por que o servidor doméstico não fica no caminho de recebimento; papel de cada componente.
- `docs/decisoes.md`: registro curto das decisões já tomadas e seus motivos, uma seção por decisão:
  - Cloudflare Email Service (beta) em vez de servidor de e-mail próprio
  - Webmail no servidor doméstico via Tunnel, em vez de no Cloudflare
  - Docker sem portas publicadas; Nginx só para outros sites, nunca na frente do webmail
  - Usuário fora do grupo `docker`
  - Login próprio com 2FA TOTP obrigatório (em vez de Cloudflare Access)
  - Repositório público e as defesas contra vazamento de segredos
  - Envio por serviços (nLogin e NodeBB) direto pelo SMTP da Cloudflare, sem servidor SMTP próprio e sem API própria por enquanto. Inclua o risco aceito (o token pode enviar por **qualquer** domínio ativado na conta), as mitigações e a condição para reavaliar antes de ativar o envio da distribuidora.
  - Envio automático pelo subdomínio `mail.survivusmc.com`, nunca pelo domínio principal; ordem de ativação dos domínios de envio
  - Tudo do Minecraft (servidor, nLogin, NodeBB) no domínio `survivusmc.com`
  - Painel de administração só na Etapa 10, sob `/admin`, com Cloudflare Access + validação do JWT; a CLI vem antes
  - Acesso remoto ao servidor pelo Tailscale com SSH por chave; DNS do servidor fora do controle do Tailscale
- `docs/segredos.md`: a tabela "onde vive cada segredo" do `CLAUDE.md`, mais:
  - um inventário vazio (nome, local, quem usa, permissões, última rotação), **sem valores**;
  - como gerar um segredo forte (`openssl rand -base64 32`);
  - como criar um arquivo de segredo com permissão correta (`install -m 600 /dev/null arquivo`);
  - o que fazer se um segredo vazar: revogar primeiro, investigar depois, e apagar do histórico **não** resolve, porque o segredo já é público;
  - regra para os outros sites no Nginx: bloquear arquivos ocultos (`location ~ /\. { deny all; }`) e manter `.env` fora da pasta pública.
- `docs/progresso.md`: criado nesta etapa e atualizado ao fim de toda sessão.
- `SECURITY.md`: como reportar uma vulnerabilidade (pode ser via GitHub Security Advisories, sem expor e-mail).
- `LICENSE`: texto oficial e completo da **AGPL-3.0** (de gnu.org), sem alterações. No `package.json` raiz e nos pacotes, use `"license": "AGPL-3.0-only"`. No README, explique em 3 linhas o que a AGPL exige de quem roda uma versão modificada como serviço.

### 8. Primeiro push

- Antes do push, rode `gitleaks` no histórico local inteiro e mostre o resultado.
- Faça o push para `main` e acompanhe o CI. Se falhar, corrija e explique o que deu errado.

## O que eu faço manualmente no GitHub (me lembre ao final, com o caminho de cada tela)

- **Settings → Code security:** ativar _Secret scanning_ e _Push protection_ (gratuitos em repositório público).
- **Settings → Branches:** regra de proteção para `main` exigindo o CI verde e bloqueando force push.
- **Settings → Actions → General:** permissões padrão do `GITHUB_TOKEN` em _Read repository contents_.

## Critérios de pronto

| Teste                                        | Esperado                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Commit com token falso                       | Bloqueado pelo hook do gitleaks                                                          |
| Commit de um arquivo `.env` com `git add -f` | Bloqueado pelo hook (o gitleaks ou uma verificação extra de nome de arquivo no lefthook) |
| `.dockerignore`                              | Exclui `.env*`, `.dev.vars`, `.git/`                                                     |
| `pnpm install` num clone novo                | Instala o hook automaticamente                                                           |
| `pnpm lint && pnpm typecheck && pnpm test`   | Tudo passa                                                                               |
| CI no GitHub após o push                     | Verde nos dois jobs                                                                      |
| `gitleaks` no histórico completo             | Nenhum vazamento                                                                         |
| `git status` após o build e os testes        | Nenhum arquivo gerado aparecendo (o `.gitignore` funciona)                               |
| `docs/progresso.md`                          | Descreve a Etapa 1 como concluída e o próximo passo (Etapa 2)                            |

## Ao terminar

1. Mostre como eu mesmo testo cada critério acima, passo a passo.
2. Liste as dependências adicionadas e por que cada uma entrou.
3. Diga o que ficou pendente ou arriscado.
4. **Pare.** Não comece a Etapa 2.

# Decisões

Registro curto das decisões já tomadas e seus motivos. Mudanças de arquitetura entram aqui antes de virar código.

## Cloudflare Email Service (beta) em vez de servidor de e-mail próprio

**Decisão:** receber pelo Cloudflare Email Routing e enviar pelo Cloudflare Email Sending. Nenhum Postfix, Dovecot ou similar.

**Motivo:** manter um servidor de e-mail exige IP com boa reputação, porta 25 aberta, antispam, atualizações constantes e monitoramento de listas de bloqueio. IP residencial é quase sempre bloqueado. A Cloudflare já hospeda o DNS dos domínios.

**Custo aceito:** o Email Sending está em beta, então a API pode mudar. Sempre conferir a documentação atual antes de usar.

## Webmail no servidor doméstico via Tunnel, em vez de no Cloudflare

**Decisão:** a interface (SvelteKit/Node) roda em container no servidor doméstico, exposta só pelo Cloudflare Tunnel. O armazenamento e o recebimento ficam no Cloudflare.

**Motivo:** o servidor já existe e roda outros serviços. O Tunnel dispensa abrir portas no roteador. Como o recebimento não depende do servidor, uma queda dele só impede a leitura, sem perder e-mails.

## Docker sem portas publicadas; Nginx só para outros sites

**Decisão:** o container do webmail não usa `ports:`. Ele só é alcançado pelo `cloudflared`, numa rede Docker exclusiva. O Nginx atende os outros sites, numa rede separada, e nunca fica na frente do webmail.

**Motivo:** portas publicadas pelo Docker criam regras de iptables que **ignoram o ufw**, então o container ficaria exposto na rede mesmo com o firewall ativo. Além disso, o webmail confia no cabeçalho `CF-Connecting-IP` para rate limit e IP ban. Isso só é seguro se nada além do `cloudflared` alcança o container. Um proxy no meio poderia repassar um cabeçalho forjado.

## Usuário fora do grupo `docker`

**Decisão:** o usuário do dia a dia não pertence ao grupo `docker`. Comandos Docker usam `sudo`.

**Motivo:** quem está no grupo `docker` é root na prática: consegue montar `/` num container e alterar qualquer arquivo. Um processo comprometido do usuário (ou um agente de IA rodando como ele) viraria root sem senha.

## Login próprio com 2FA TOTP obrigatório (em vez de Cloudflare Access)

**Decisão:** o webmail tem login próprio, com usuário + senha (argon2id) + TOTP obrigatório, rate limit e IP ban. Sem cadastro público.

**Motivo:** a relação usuário ↔ caixa e as permissões vivem no D1 e precisam de um usuário identificado pelo próprio app. Isso não depende de um serviço externo e funciona igual para os 4 usuários. O Cloudflare Access entra como camada **extra**, só no painel `/admin` (veja abaixo).

## Repositório público e defesas contra vazamento de segredos

**Decisão:** o repositório é público (licença AGPL-3.0-only). Zero segredos em commits.

**Defesas:**

- `.gitignore` **e** `.dockerignore` excluem `.env*`, `.dev.vars`, `*.pem`, `*.key`, `.npmrc`.
- Hook de pre-commit (lefthook) com bloqueio por nome de arquivo, gitleaks nos arquivos staged e Biome. Instalado sozinho no `pnpm install`.
- CI roda o gitleaks no histórico completo a cada push e pull request.
- No GitHub: Secret scanning e Push protection ativados.
- Segredos vivem só onde descreve [`segredos.md`](segredos.md).

**Motivo:** um segredo commitado num repositório público é considerado vazado no mesmo instante: robôs varrem o GitHub em minutos. Apagar do histórico não adianta.

**Cadeia de suprimentos (pnpm):** só versões publicadas há pelo menos 7 dias (`minimumReleaseAge`), falha se o nível de confiança de publicação de um pacote cair (`trustPolicy: no-downgrade`), scripts de instalação bloqueados exceto os listados em `allowBuilds` (hoje nenhum). Dependências entram só quando necessárias, com motivo registrado.

## Envio por serviços direto pelo SMTP da Cloudflare

**Decisão:** nLogin e NodeBB enviam pelo SMTP da própria Cloudflare (`smtp.mx.cloudflare.net`, porta 465, TLS implícito), cada um com seu próprio token. Este projeto não hospeda servidor SMTP e não terá uma API própria de envio (`/v1/send`) por enquanto.

**Motivo:** os dois são software de terceiros que já falam SMTP. Um servidor SMTP ou uma API própria seriam mais código e mais superfície de ataque sem nenhum consumidor que precise deles. A API só entra se houver código próprio que envie e-mail.

**Risco aceito:** um token SMTP da Cloudflare consegue enviar por **qualquer domínio ativado para envio na conta**, não só pelo domínio do serviço. Um token vazado do nLogin poderia enviar como `contato@survivus.com.br` se esse domínio estiver ativado.

**Mitigações:**

- Ativar o Email Sending só nos domínios que precisam enviar agora, na ordem da seção seguinte.
- Um token por serviço, com só a permissão _Email Sending: Edit_, criado na hora de configurar e colado direto no serviço.
- Remetente fixo por serviço, para os logs mostrarem quem enviou.
- Rotação a cada 6 meses ou na hora em caso de suspeita.
- Monitorar os logs de entrega e os relatórios DMARC.

**Condição para reavaliar:** **antes de ativar o envio para `dirdistribuidora.com.br`.** Tokens dentro do nLogin/NodeBB não podem ser capazes de enviar como a distribuidora. Opção prevista: um relay interno (rede Docker sem portas publicadas) com credencial e remetente fixos por serviço, em que só o relay guarda o token real.

## Envio automático por subdomínio; ordem de ativação

**Decisão:** envio automático sempre por `mail.survivusmc.com`, nunca pelo domínio principal. Ordem de ativação do Email Sending:

1. `mail.survivusmc.com` (Etapa 4): nLogin e NodeBB.
2. `survivus.com.br` (Etapa 8): respostas do webmail como `contato@`, `suporte@`, `compras@`.
3. `dirdistribuidora.com.br` (Etapa 12), após reavaliar o relay.

**Motivo:** o subdomínio isola a reputação (um problema com e-mails automáticos não afeta o domínio usado para atendimento), limita o estrago de um token vazado e evita conflito de SPF com o Email Routing no domínio principal.

## Tudo do Minecraft no domínio `survivusmc.com`

**Decisão:** servidor Minecraft, nLogin, fórum NodeBB (ex.: `forum.survivusmc.com`) e envio automático (`mail.survivusmc.com`) usam `survivusmc.com`.

**Motivo:** separa a comunidade do jogo do domínio institucional `survivus.com.br`. Problemas de reputação ou abuso ligados ao jogo ficam contidos num domínio.

## Painel de administração só na Etapa 10, sob `/admin`

**Decisão:** a administração começa pela CLI (`pnpm admin ...`), que continua existindo para sempre. O painel web entra só na Etapa 10, com estas regras:

- Tudo administrativo fica sob `/admin`, protegido pelo **Cloudflare Access** além do login com 2FA.
- O app valida o JWT do Access (`Cf-Access-Jwt-Assertion`: assinatura, `aud`, expiração) em toda rota `/admin`. Se o Access for desligado por engano, o painel fica fechado.
- Exige o papel `admin`. Ações sensíveis pedem o TOTP de novo. Tudo vai para o log de auditoria.
- Tokens SMTP aparecem só como inventário, nunca o valor.

**Motivo:** a CLI tem superfície de ataque mínima e basta no começo. O painel é o alvo mais valioso do sistema, então ganha uma camada a mais e regras que falham fechadas.

## Acesso remoto ao servidor pelo Tailscale, com SSH por chave

**Decisão:** o acesso remoto ao servidor é pelo Tailscale, com SSH só por chave (sem senha). O DNS do servidor fica fora do controle do Tailscale.

**Motivo:** o Tailscale dispensa expor a porta 22 na internet e abrir portas no roteador. A chave SSH elimina ataques de força bruta de senha. Deixar o DNS do sistema fora do Tailscale evita que uma falha ou mudança no Tailscale quebre a resolução de nomes dos serviços do servidor (Tunnel, Docker, Minecraft).

## Mudanças na `main` só por Pull Request com CI verde

**Decisão:** a `main` tem um ruleset que exige os checks `quality` e `secrets` verdes, bloqueia force push e impede a exclusão da branch. Todo trabalho é feito numa branch e entra por Pull Request.

**Motivo:** um check obrigatório só pode ser cumprido por um commit que já rodou o CI, ou seja, num PR. O push direto na `main` fica bloqueado. Assim nenhum commit com segredo, lint quebrado ou teste falhando chega à `main`. Não há bypass para o dono: um bypass liberaria também o force push.

## Regra catch-all do Email Routing para o Worker

**Decisão:** o Email Routing de cada domínio tem uma regra catch-all que entrega tudo ao Worker `mail-core`. Quem decide se o endereço existe é a tabela `mailboxes` do D1. Endereço inexistente é recusado com `setReject` durante a conversa SMTP.

**Motivo:** criar ou desativar uma caixa vira uma mudança no banco, sem mexer no painel. O remetente recebe o erro na hora, e nós não geramos e-mail de retorno (que poderia ser usado para backscatter).

## Identificadores no repositório, `account_id` fora

**Decisão:** o `database_id` do D1, o nome do bucket R2 e os nomes das filas ficam no `wrangler.jsonc` commitado. O `account_id` **não** fica: o Wrangler lê da variável `CLOUDFLARE_ACCOUNT_ID`.

**Motivo:** sem um token, esses identificadores não dão acesso a nada, e o Wrangler precisa deles no arquivo. O `account_id` não é necessário no arquivo e identifica a conta inteira, então fica fora por precaução.

## Fila entre o recebimento e o processamento

**Decisão:** o handler `email` só valida, deduplica, grava o `.eml` no R2 e manda a chave para a fila `mail-ingest` (Cloudflare Queues). Um consumidor da fila faz o parse, grava os anexos e o D1, com retries e a dead letter queue `mail-ingest-dlq`. Se o R2, a fila ou o D1 falharem no handler, ele lança a exceção, que vira falha temporária (veja a decisão seguinte), e nunca usa `setReject`.

**Motivo:** com a fila, o handler faz o mínimo: o trabalho que pode falhar por mais tempo (D1, parse) ganha retries automáticos sem depender do remetente tentar de novo.

**Limitações aceitas:**

- Uma mensagem que esgota os retries fica na DLQ por 14 dias (retenção configurada na criação das filas; o padrão seria 4). O `.eml` continua no R2, com os metadados do envelope no `customMetadata`, mas para reaparecer no webmail precisa de uma ferramenta de reprocessamento (em "Depois" no `progresso.md`).
- Se a fila falha depois da gravação no R2, o `.eml` fica em `raw/` sem linha no D1, e a nova tentativa do remetente grava outra cópia. O reprocessamento (em "Depois") precisa tratar essa cópia como duplicata pela `dedupeKey`.

## Exceção no handler é falha temporária: sem encaminhamento de reserva

**Decisão:** em falha do R2, da fila ou do D1, o handler `email` registra `internal_error` e relança a exceção. O encaminhamento com `forward()` para um endereço de reserva e o secret `FALLBACK_FORWARD_TO` foram removidos em 2026-10-28.

**Evidência (teste 5 do PR 2, 2026-10-28):** um Worker descartável (`mail-test-scratch`) que sempre lançava exceção recebeu uma mensagem do Gmail num endereço de teste.

- O Registro de atividade do Email Routing mostrou 7 tentativas da mesma mensagem (mesmo `Message-ID`) entre 17:59 e 22:00 UTC, com intervalos crescentes, que é o padrão de reenvio do Gmail.
- O motivo registrado em cada tentativa foi: "upstream (worker:mail-test-scratch) temporary error: worker script threw an exception".
- O `wrangler tail` mostrou `outcome: exception` em cada entrega, e o remetente não recebeu nenhum aviso de falha durante as tentativas.

**Motivo:** a documentação da Cloudflare não dizia o que acontecia com uma exceção, e o encaminhamento de reserva existia para o caso de a mensagem se perder. O teste mostrou que a Cloudflare responde ao remetente com erro temporário e o servidor dele tenta de novo, então nada se perde. Sem o encaminhamento, a mensagem nunca sai do nosso controle para uma caixa pessoal, e não há secret nem endereço verificado para manter.

**Limitações aceitas:**

- Quanto tempo o remetente insiste depende do servidor dele (a RFC 5321 recomenda pelo menos 4 a 5 dias). Uma falha mais longa que isso faz o servidor do remetente devolver a mensagem para ele, com aviso. A mensagem não some em silêncio.
- Enquanto a falha dura, a mensagem atrasa.

**Regra geral:** se algum encaminhamento voltar a ser usado, o destino nunca pode estar num domínio atendido pelo `mail-core`, senão a mensagem volta para o próprio Worker.

## Só o `Authentication-Results` do topo, e só de `authserv-id` confiável

**Decisão:** o resultado de SPF, DKIM e DMARC vem só do primeiro `Authentication-Results` da mensagem, e só se o `authserv-id` dele estiver em `TRUSTED_AUTHSERV_IDS`. A lista tem `mx.cloudflare.net`, confirmado numa mensagem real no PR 2 (teste 3). No SPF, vale o resultado com `smtp.mailfrom`: a Cloudflare escreve dois, um para o HELO (`smtp.helo`, que costuma dar `none`) e outro para o remetente do envelope, que é o que o DMARC usa. Sem `smtp.mailfrom`, vale o primeiro.

**Motivo:** qualquer remetente pode incluir um `Authentication-Results: ...; dmarc=pass` falso. Um cabeçalho de outro servidor não prova nada. Na mensagem real, o cabeçalho da Cloudflare foi o primeiro, logo abaixo do `Received` dela, então um cabeçalho forjado fica abaixo e é ignorado.

**Não testado:** se a Cloudflare remove ou renomeia um `Authentication-Results` que já chega com o `authserv-id` dela (RFC 8601, seção 5). Pelo Gmail não dá para testar. O risco existe só se a Cloudflare deixar de acrescentar o próprio cabeçalho: aí o forjado ficaria no topo. Hoje o efeito de um resultado errado é só a pasta (DMARC `fail` vai para `spam`).

**Antes de qualquer selo de "remetente verificado" na interface (Etapa 6):** reforçar a checagem. Por exemplo: exigir que o `Authentication-Results` confiável venha logo depois do `Received` da Cloudflare, ou conferir o `ARC-Seal` assinado por `cloudflare-email.net`. Um selo faz o usuário confiar no remetente, então um cabeçalho forjado passaria a ter um efeito muito maior.

## Scripts de instalação do `esbuild` e do `workerd` bloqueados

**Decisão:** `esbuild` e `workerd` (dependências do Wrangler) ficam com `false` no `allowBuilds`.

**Motivo:** os dois trazem o binário nativo num pacote opcional por plataforma. O script de instalação só confere ou copia esse binário, e os testes e o `wrangler types` funcionam sem ele. Menos código de terceiros rodando no `pnpm install`.

## Deduplicação por `Message-ID` e cabeçalhos; duplicata guardada, não descartada

**Decisão:** a chave de deduplicação é a caixa + SHA-256 do `Message-ID` junto com os cabeçalhos `From`, `Date`, `Subject` e `To` normalizados (espaços repetidos viram um só, sem espaços nas pontas). Sem `Message-ID`, é o SHA-256 do `.eml` inteiro. Uma duplicata não é descartada: o `.eml` vai para `dup/AAAA/MM/<uuid>.eml` no R2, com os mesmos `customMetadata`, sem entrar na fila, e o log registra só o UUID e o hash da chave.

**Motivo:** a deduplicação só pelo `Message-ID` deixava perder mensagens em silêncio. Sistemas com IDs sequenciais ou repetidos, ou um terceiro que conhecesse o `Message-ID` de uma mensagem futura, fariam a mensagem verdadeira ser descartada. Com os cabeçalhos na chave, o mesmo `Message-ID` com conteúdo diferente vira mensagem nova. E se a decisão de duplicata estiver errada, o `.eml` continua guardado.

**Custo aceito:**

- A mesma mensagem reenviada com um cabeçalho reescrito no caminho (por exemplo, um assunto recodificado) entra duas vezes na caixa. Duplicar é melhor que perder.
- O `dup/` cresce sem limpeza automática. A limpeza e o reprocessamento estão em "Depois" no `progresso.md`.

## Email Routing pelo painel; token do Wrangler sem permissões de zona

**Decisão:** ativar o Email Routing, verificar o endereço de reserva e criar o catch-all são feitos à mão no painel (passo a passo em `docs/cloudflare.md`). O token do Wrangler só tem permissões de conta (Workers Scripts, D1, R2, Queues, Workers Tail, User Details) e expira em 2026-11-30.

**Motivo:** ativar o Email Routing pela API exige *Zone Settings: Edit*, que também permite mudar outras configurações da zona (SSL, por exemplo). São três ações feitas uma vez só, então não compensa deixar essa permissão num token que fica guardado no servidor.

## API interna com dois cadeados: Cloudflare Access e bearer

**Decisão:** a API do `mail-core` (`docs/api.md`) fica atrás de dois controles independentes.
1. **Cloudflare Access com Service Token** no hostname da API: sem `CF-Access-Client-Id` e `CF-Access-Client-Secret`, o pedido é barrado na borda.
2. **Bearer** (`INTERNAL_API_TOKEN`), comparado pelo Worker em tempo constante.

O Worker também valida o JWT do Access (`Cf-Access-Jwt-Assertion`):
- só RS256;
- `iss` exatamente igual ao team domain;
- `aud` contendo o AUD da aplicação;
- `exp` obrigatório;
- `exp` e `nbf` com no máximo 60 s de tolerância;
- `common_name` igual ao Client ID do Service Token `webmail`.

**Motivo:** vazar um só dos segredos não basta para entrar. Validar o JWT no Worker mantém a API **fechada** se o Access for desligado ou mal configurado por engano (mesma regra do `/admin`). Conferir o `common_name` barra outro Service Token, caso alguém acrescente outra política na aplicação.

- **Fonte das chaves fixa no código:** só o `src/index.ts` escolhe a fonte, e é sempre a URL de certificados do Access. O team domain precisa ter a forma `https://<nome>.cloudflareaccess.com`, então nenhuma configuração aponta a busca de chaves para outro servidor. A chave de teste só entra pelo código de teste (`createApi(chaves)`).
- **`nbf` só quando existe:** o exemplo de payload de Service Token da documentação não tem `nbf`. Exigir esse campo poderia barrar o token real. O `exp` é obrigatório.

## Sem permissão é 404, não 403

**Decisão:** caixa, mensagem, anexo ou `.eml` sem permissão respondem 404, com o mesmo corpo de um recurso inexistente. Toda rota com `:id` de mensagem descobre a caixa **pela mensagem** e confere `user_mailboxes.can_read`. Um anexo só é achado dentro da mensagem já autorizada.

**Motivo:** quem não tem acesso não consegue nem saber se a mensagem existe. Nenhum ID vindo do pedido decide o acesso.

## Anexos e `.eml` sempre como download

**Decisão:** todo download sai com:
- `Content-Type: application/octet-stream`;
- `Content-Disposition: attachment`, com o nome limpo;
- `X-Content-Type-Options: nosniff`;
- `Cache-Control: private, no-store`.

O tipo declarado pelo remetente só aparece nos metadados em JSON. O HTML do e-mail sai como dado dentro de JSON, nunca como `text/html`.

**Motivo:** um anexo HTML ou SVG aberto como página do nosso domínio rodaria script do remetente. A decisão sobre o que exibir fica com o webmail (Etapa 6), que sanitiza.

## Sem CORS na API

**Decisão:** nenhuma resposta tem `Access-Control-*`, nem para *preflight*.

**Motivo:** a API é chamada de servidor para servidor (webmail → `mail-core`). Sem CORS, nenhuma página aberta num navegador consegue ler as respostas, mesmo que obtenha algum segredo.

## Rate limit por usuário com o binding do Workers

**Decisão:** 100 pedidos por minuto por usuário, com o binding `ratelimits` (chave = ID do usuário), depois da autenticação.

**Motivo:** limita o estrago de um webmail comprometido ou com defeito. O binding é aproximado e vale por local da Cloudflare (`docs/cloudflare-api.md`): é proteção contra abuso, não cota exata.

## Nenhuma exceção no gitleaks

**Decisão:** não usamos `gitleaks:allow` nem allowlist no `.gitleaks.toml`, a não ser com o "ok" explícito do Daniel. Um valor que o gitleaks barra fica fora do repositório, mesmo quando não é segredo.

**Caso que motivou:** o `ACCESS_AUD` (AUD tag da aplicação do Access) foi barrado pela regra genérica de chaves. Ele não é segredo: o Access o devolve a qualquer um no cabeçalho `cf-access-aud`. Mesmo assim virou secret do Worker (`wrangler secret put`), e só o `ACCESS_TEAM_DOMAIN` ficou em `vars`.

**Motivo:** cada exceção é um ponto cego permanente no scanner. Uma linha liberada hoje pode receber um segredo de verdade amanhã sem nenhum aviso.

## Workers Logs desligados

**Decisão:** o armazenamento dos Workers Logs fica desligado (`observability.enabled: false` e `logs.enabled: false` no `wrangler.jsonc`). O `wrangler tail` continua mostrando os logs ao vivo, sem guardar nada.

**Motivo:** medido em 2026-10-29 (tarefa 8 da Etapa 3), a Cloudflare grava junto com cada `log()` os dados da invocação, mesmo com `invocation_logs: false`:
- no evento de e-mail, `$workers.event.mailFrom` (o remetente completo do envelope), `$workers.event.rcptTo` e `$metadata.trigger`;
- num pedido da API, `$workers.event.request.url` (a URL completa, com ids e query string).

Não há opção para excluir esses campos. O `redact_query_string` do `wrangler.jsonc` só tira a query string da URL: não resolve o `mailFrom` nem os ids no caminho. A regra do projeto proíbe guardar o endereço completo, então o armazenamento sai.

**Consequência na API:** a busca passou de `GET /v1/search?q=` para `POST /v1/search`, com o termo no corpo JSON. O termo nunca vai numa URL, que plataformas e proxies costumam registrar.

**Depois:** um Tail Worker que receba os eventos do `mail-core` e guarde só os campos do nosso `log()` (`docs/progresso.md`, seção "Depois").

## Envio só por `mail.survivusmc.com`

**Decisão:** na Etapa 4, só o subdomínio `mail.survivusmc.com` fica ativado no Email Sending. O `survivus.com.br`, ativado numa tentativa antiga, foi removido em 2026-10-30. O Email Routing dele continua funcionando.

**Motivo:** um token SMTP envia por **qualquer** domínio ativado na conta. Com só o subdomínio ativado, um token vazado do nLogin ou do NodeBB não envia como `contato@survivus.com.br`.

**Medido:**
- `contato@survivus.com.br` e `contato@survivusmc.com` (domínios não ativados) foram recusados com `550`, mesmo para um destino verificado do Email Routing.
- O `550` do domínio principal `survivusmc.com` **só vale enquanto ele não estiver ativado** no Email Sending. Ativar o domínio principal (Etapa 11) exige reavaliar os tokens do nLogin e do NodeBB, como na Etapa 12. A partir daí, um token desses enviaria como `contato@survivusmc.com`.

**Também decidido:**
- DMARC de `mail.survivusmc.com`: fica o `p=reject` criado pelo onboarding, com o `rua` do DMARC Management (o mesmo do domínio principal). A etapa sugeria começar com `p=none`. Como o subdomínio só envia pela Cloudflare e o teste mostrou DMARC `pass` alinhado, não há motivo para afrouxar.
- *Drop suppressed recipients* desligado (padrão). Ligado, um envio para um destinatário suprimido responde `250` sem entregar nada. Desligado, o nLogin recebe o erro.
- *Email preview* desligado em `mail.survivusmc.com`: ele guardaria por cerca de 7 dias o conteúdo das mensagens, incluindo os códigos de recuperação. Ele só é ligado por pouco tempo, para depurar.
- Sem assinatura DKIM pelo domínio principal (`d=survivusmc.com`), só para o Gmail mostrar "assinado por: survivusmc.com". O ganho seria só visual, e o DMARC já passa com `mail.survivusmc.com`.

## Autenticação do webmail (Etapa 5)

**Senha e código verificados no webmail, não no Worker.** O argon2id com parâmetros decentes (64 MiB, `docs/webmail-auth.md`) não cabe no limite de CPU de um Worker. O webmail busca o hash em `POST /v1/auth/lookup` e verifica localmente. Os dados continuam no D1, a fonte da verdade.

**Segredo TOTP cifrado, com o id do usuário como dado associado.** AES-256-GCM com a `TOTP_ENCRYPTION_KEY`, que só o webmail conhece. Quem lê o D1 não gera códigos. O id do usuário entra como AAD: colar no D1 o segredo cifrado de outro usuário faz a decifragem falhar. Perder a chave não perde e-mail: obriga a refazer o 2FA de todos pela CLI.

**Token de administração separado (`ADMIN_API_TOKEN`).** Só a CLI tem. O `INTERNAL_API_TOKEN` não abre `/v1/admin/*`, e o `ADMIN_API_TOKEN` não abre as outras rotas. Se o webmail for comprometido, o atacante não cria um usuário para manter acesso nem reseta o 2FA de ninguém.
- O grupo de cada rota é decidido pelo **padrão da rota casada**, não pelo texto da URL: uma URL codificada ou com barra dupla não muda o token exigido.
- O `audit_log` tem a coluna `source` (`cli` ou `webmail`), definida pelo token que gravou, nunca pelo corpo. A CLI grava as ações locais (bans, sessões) por `POST /v1/admin/audit`.

**Um formulário só no login** (usuário, senha e código), sempre com a mesma mensagem de erro: o atacante nunca sabe se acertou a senha. Usuário inexistente custa o mesmo tempo (hash falso com os mesmos parâmetros).

**Sem códigos de recuperação nesta etapa.** Perdeu o celular: o administrador reseta pela CLI. Com 4 pessoas é mais simples, e é um segredo a menos. Está no "Depois".

**Riscos aceitos:**
- **Quem compromete o webmail lê todas as caixas.** A permissão por caixa confia no `X-Webmail-User` que o webmail manda (vale desde a Etapa 3). O token de admin separado só impede criar usuários e resetar o 2FA.
- **Bloqueio por username permite negar acesso:** um atacante pode manter um username bloqueado. Com 4 usuários e a CLI para liberar, aceito. O ban por IP é a defesa principal.
- **Rate limit compartilhado das rotas de serviço:** `/v1/auth/*` e `/v1/audit` dividem uma chave (`service`, 100 por minuto). Um ataque distribuído que passe pelos bans do webmail pode atrasar o login de todos. Com 4 usuários, aceito.
- **Etapa 7:** a CLI precisa do SQLite de dentro do container (sessões e bans). O jeito de rodá-la lá fica para a Etapa 7.

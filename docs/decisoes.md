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

**Decisão:** o handler `email` só valida, deduplica, grava o `.eml` no R2 e manda a chave para a fila `mail-ingest` (Cloudflare Queues). Um consumidor da fila faz o parse, grava os anexos e o D1, com retries e a dead letter queue `mail-ingest-dlq`. Se o R2, a fila ou o D1 falharem no handler, ele encaminha a mensagem com `forward()` para um endereço de reserva verificado (`FALLBACK_FORWARD_TO`, guardado como secret), e nunca usa `setReject`.

**Motivo:** a Cloudflare não documenta o que o remetente recebe quando o handler lança uma exceção, e a API não tem "falha temporária" (veja `cloudflare-email-routing.md`). Com a fila, o handler faz o mínimo: o trabalho que pode falhar por mais tempo (D1, parse) ganha retries automáticos sem depender do remetente tentar de novo.

**Limitações aceitas:**

- Uma mensagem que esgota os retries fica na DLQ por só 4 dias. O `.eml` continua no R2, com os metadados do envelope no `customMetadata`, mas para reaparecer no webmail precisa de uma ferramenta de reprocessamento (em "Depois" no `progresso.md`).
- O endereço de reserva fica como secret, e não em `vars`, porque é um e-mail pessoal e o repositório é público. O código recusa um endereço no próprio domínio do destinatário, para não criar um loop.

## Só o `Authentication-Results` do topo, e só de `authserv-id` confiável

**Decisão:** o resultado de SPF, DKIM e DMARC vem só do primeiro `Authentication-Results` da mensagem, e só se o `authserv-id` dele estiver em `TRUSTED_AUTHSERV_IDS`. A lista começa vazia: até o PR 2 confirmar o valor real, tudo fica `unknown`.

**Motivo:** qualquer remetente pode incluir um `Authentication-Results: ...; dmarc=pass` falso. Um cabeçalho de outro servidor não prova nada.

**Pendente (PR 2):** confirmar que a Cloudflare remove ou renomeia um `Authentication-Results` que chega com o `authserv-id` dela (RFC 8601, seção 5). Se não remover, um atacante consegue forjar o id quando a Cloudflare não acrescenta o próprio cabeçalho.

## Scripts de instalação do `esbuild` e do `workerd` bloqueados

**Decisão:** `esbuild` e `workerd` (dependências do Wrangler) ficam com `false` no `allowBuilds`.

**Motivo:** os dois trazem o binário nativo num pacote opcional por plataforma. O script de instalação só confere ou copia esse binário, e os testes e o `wrangler types` funcionam sem ele. Menos código de terceiros rodando no `pnpm install`.

## Deduplicação por `Message-ID` e cabeçalhos; duplicata guardada, não descartada

**Decisão:** a chave de deduplicação é a caixa + SHA-256 do `Message-ID` junto com os cabeçalhos `From`, `Date`, `Subject` e `To` normalizados (espaços repetidos viram um só, sem espaços nas pontas). Sem `Message-ID`, é o SHA-256 do `.eml` inteiro. Uma duplicata não é descartada: o `.eml` vai para `dup/AAAA/MM/<uuid>.eml` no R2, com os mesmos `customMetadata`, sem entrar na fila, e o log registra só o UUID e o hash da chave.

**Motivo:** a deduplicação só pelo `Message-ID` deixava perder mensagens em silêncio. Sistemas com IDs sequenciais ou repetidos, ou um terceiro que conhecesse o `Message-ID` de uma mensagem futura, fariam a mensagem verdadeira ser descartada. Com os cabeçalhos na chave, o mesmo `Message-ID` com conteúdo diferente vira mensagem nova. E se a decisão de duplicata estiver errada, o `.eml` continua guardado.

**Custo aceito:**

- A mesma mensagem reenviada com um cabeçalho reescrito no caminho (por exemplo, um assunto recodificado) entra duas vezes na caixa. Duplicar é melhor que perder.
- O `dup/` cresce sem limpeza automática. A limpeza e o reprocessamento estão em "Depois" no `progresso.md`.

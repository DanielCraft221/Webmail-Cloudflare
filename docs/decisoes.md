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

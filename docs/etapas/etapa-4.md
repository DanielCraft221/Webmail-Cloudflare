# Etapa 4: Envio para serviços (`mail.survivusmc.com`)

> **Pré-requisito:** Etapa 3 concluída e mergeada (`docs/progresso.md` aponta a Etapa 4).
> As regras permanentes estão em `CLAUDE.md`. Siga-as durante toda a etapa.

## Objetivo

Deixar o subdomínio `mail.survivusmc.com` pronto para **enviar** e-mail pelo SMTP da Cloudflare, com SPF, DKIM e DMARC corretos, e provar a entrega com um teste real. Deixar documentado como o nLogin e o NodeBB se conectam.

**Fora desta etapa:** envio pelo webmail e o domínio `survivus.com.br` (Etapa 8); o relay interno (reavaliação na Etapa 12); a configuração do NodeBB, que ainda não está instalado.

## Antes de começar

1. Atualize a `main` com `git pull --ff-only origin main` e confirme que o `git status` está limpo.
2. O `git pull --ff-only` sem argumentos falhou na sessão anterior com "Cannot fast-forward to multiple branches". Investigue a causa (por exemplo, `git config --get-all branch.main.merge` e `git config --get-all remote.origin.fetch`), me explique e proponha a correção. **Não altere a configuração do git sem meu ok.**
3. Crie o branch `etapa-4/envio` e mova este arquivo para `docs/etapas/etapa-4.md` nele.
4. Faça a pesquisa da tarefa 1.
5. Apresente o plano em tópicos curtos e **espere minha aprovação**.

## Decisões já tomadas (não reabra sem me perguntar)

- **Só `mail.survivusmc.com` é ativado para envio nesta etapa.** O token SMTP envia por qualquer domínio ativado na conta, então nada além disso pode estar ativado. Se a pesquisa encontrar outro domínio ou subdomínio ativado no Email Sending (por exemplo, uma tentativa antiga com `survivus.com.br`), pare e me avise.
- **Remetentes fixos:** nLogin → `nao-responda@mail.survivusmc.com`; NodeBB → `forum@mail.survivusmc.com`.
- **Um token por serviço**, account-owned, só com *Email Sending: Edit*, criado **na hora** de configurar o serviço. Nesta etapa só existe um **token temporário de teste**, revogado no fim.
- **Mudanças de DNS e de Email Sending são feitas por mim no painel**, com você me guiando tela a tela. O token do Wrangler continua sem permissões de zona.
- **Token nunca em argumento de linha de comando.** Argumentos aparecem no `ps` para outros processos. Os testes leem o token de arquivo (`chmod 600`) ou de variável carregada do arquivo.

## Tarefas

### 1. Pesquisa (antes de qualquer mudança)

Confira na documentação atual da Cloudflare e registre em `docs/cloudflare-envio.md`, com links:

- O que o onboarding do Email Sending cria no DNS para um **subdomínio** (SPF, DKIM, MX ou CNAME de retorno, `cf-bounce`) e se isso conflita com o domínio principal `survivusmc.com` (que hoje não tem Email Routing).
- A cota diária inicial de uma conta nova e onde ver no painel.
- **DMARC:** a forma mais simples de receber e ler relatórios. Avalie o **DMARC Management** da própria Cloudflare (gratuito, mostra os relatórios no painel). Política inicial recomendada para um subdomínio que só envia pela Cloudflare.
- A configuração "Drop suppressed recipients" e o efeito dela no nosso caso (mensagens com um único destinatário).
- Onde ver os **logs de entrega** do Email Sending no painel.

### 2. Estado atual (só leitura)

- Liste, pelo painel ou pela API com permissão de leitura, **quais domínios estão ativados no Email Sending**. Esperado: nenhum.
- Mostre os registros DNS atuais de `survivusmc.com` e de `mail.survivusmc.com` (com `dig`, sem token): MX, TXT (SPF, DMARC) e CNAME.

### 3. Ativação (eu faço no painel, você guia)

1. Email Sending → zona `survivusmc.com` → subdomínio `mail`.
2. Antes de confirmar, me mostre os registros que serão criados e confira se nenhum mexe no domínio principal de um jeito inesperado. **Um domínio só pode ter um registro SPF.**
3. Depois de ativado, confira com `dig` que os registros existem e estão corretos.
4. **DMARC** de `mail.survivusmc.com` conforme a pesquisa: começar com `p=none` e relatórios ligados. A mudança para `quarantine`/`reject` fica registrada em "Depois", para quando os relatórios mostrarem só envios legítimos.

### 4. Teste de entrega (token temporário)

1. Eu crio o token `smtp-teste`: account-owned, só *Email Sending: Edit*, validade de 1 dia. Você me passa os comandos para gravar em `~/.config/cloudflare/smtp-teste.env` sem o valor aparecer na tela.
2. Crie `scripts/smtp-test.sh` (vai para o repositório): envia uma mensagem de texto simples pelo `smtp.mx.cloudflare.net:465` com `curl` (TLS implícito), lendo o token do arquivo indicado, sem imprimir o valor e **sem colocá-lo em argumento de linha de comando**. Parâmetros: arquivo do token, remetente, destinatário.
3. Testes:

| Teste | Esperado |
|---|---|
| `nao-responda@mail.survivusmc.com` → meu Gmail | Chega na caixa de entrada (ou no spam: anote) |
| O mesmo → meu Outlook | Chega |
| Cabeçalhos da mensagem recebida | SPF, DKIM e DMARC = `pass`, alinhados com `mail.survivusmc.com` |
| Remetente `contato@survivus.com.br` (domínio **não** ativado) | **Recusado** (`550 5.7.1 Sender denied` ou equivalente). Prova de que o token não envia por domínios fora do Email Sending |
| Senha errada | Recusado na autenticação |
| Logs de entrega no painel | Os envios aparecem |

4. **Revogue o token `smtp-teste` no fim** e apague o arquivo. Eu confirmo no painel.

### 5. Documentação para os serviços

`docs/smtp-servicos.md`, com:

- **Parâmetros comuns:** host `smtp.mx.cloudflare.net`, porta `465`, TLS implícito (SSL, **não** STARTTLS), usuário `api_token`, senha = token do serviço.
- **nLogin:** onde ficam essas opções no `config.yml` do plugin, dentro de `~/crafty/servers/...`. Remetente `nao-responda@mail.survivusmc.com`. Como deixar o arquivo legível só pelo usuário do servidor.
- **NodeBB:** onde fica a configuração de SMTP no painel de administração. Remetente `forum@mail.survivusmc.com`. Fica marcado como "para quando o NodeBB for instalado".
- **Como criar o token de cada serviço** (nome `smtp-nlogin` / `smtp-nodebb`, permissão, validade) e registrar no `docs/segredos.md`, sem valor.
- **Rotação:** a cada 6 meses ou na hora, se houver suspeita.
- **Como testar depois de configurar:** o `scripts/smtp-test.sh` com o token do próprio serviço.

### 6. nLogin (só se o servidor Minecraft já estiver rodando no Crafty)

Se o servidor existir e o nLogin estiver instalado: crie comigo o token `smtp-nlogin`, configure o plugin, teste uma recuperação de senha real e registre no `docs/segredos.md`. Se o servidor ainda não existir, isso fica para depois, sem criar token.

### 7. Documentação final

- `docs/cloudflare-envio.md`: pesquisa e o que foi configurado no painel.
- `docs/decisoes.md`: só `mail.survivusmc.com` ativado, DMARC inicial, teste do remetente não ativado.
- `docs/segredos.md`: tokens criados e revogados, sem valores.
- `CLAUDE.md`: seção "Comandos" com o `scripts/smtp-test.sh`.
- `docs/progresso.md`: ao fim de cada sessão.

## Critérios de pronto

| Teste | Esperado |
|---|---|
| Domínios ativados no Email Sending | **Só** `mail.survivusmc.com` |
| DNS | SPF, DKIM e DMARC do subdomínio corretos; um único SPF por nome |
| E-mail de teste no Gmail e no Outlook | Entregue, com SPF, DKIM e DMARC = `pass` |
| Remetente de domínio não ativado | Recusado |
| Token `smtp-teste` | Revogado e arquivo apagado |
| `scripts/smtp-test.sh` | No repositório, sem token em argumento nem na saída |
| `docs/smtp-servicos.md` | Suficiente para eu configurar o nLogin e o NodeBB sozinho |
| `gitleaks` no histórico | Nenhum vazamento |
| `docs/progresso.md` | Etapa 4 concluída, próximo passo: Etapa 5 |

## Ao terminar

1. Mostre como eu mesmo testo cada critério, passo a passo.
2. Diga o que ficou pendente ou arriscado, principalmente o que a pesquisa não confirmou.
3. **Pare.** Não comece a Etapa 5.

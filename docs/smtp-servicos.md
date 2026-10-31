# Envio por serviços (nLogin, NodeBB) pelo SMTP da Cloudflare

Os serviços de terceiros enviam direto para o SMTP da Cloudflare. O envio **não passa** pelo `mail-core`.
Pesquisa e estado do Email Sending: `docs/cloudflare-envio.md`.

## Parâmetros comuns

| Campo | Valor |
|---|---|
| Servidor | `smtp.mx.cloudflare.net` |
| Porta | `465` |
| Criptografia | SSL / TLS implícito. **Não** use 587 nem STARTTLS: a Cloudflare não aceita |
| Usuário | `api_token` (literal) |
| Senha | o token do serviço (veja abaixo) |
| Domínio do remetente | `mail.survivusmc.com`, o único ativado no Email Sending |

| Serviço | Remetente | Token |
|---|---|---|
| nLogin | `nao-responda@mail.survivusmc.com` | `smtp-nlogin` |
| NodeBB | `forum@mail.survivusmc.com` | `smtp-nodebb` |

Um remetente e um token por serviço: o Activity log mostra quem enviou, e um token vazado é revogado sem parar o outro serviço.

## Criar o token de um serviço

Crie **só na hora de configurar o serviço** e cole direto na configuração dele. Nunca num bloco de notas, chat ou mensagem.

1. Painel da Cloudflare › **Manage Account › Account API Tokens › Create Token › Custom token**.
2. Nome: `smtp-nlogin` ou `smtp-nodebb`.
3. Permissão: **Account › Email Sending › Edit**. Nenhuma outra.
4. Recurso da conta: só a conta do projeto.
5. Sem data de expiração curta (o serviço precisa dele sempre). A rotação é manual, a cada 6 meses.
6. Copie o token, cole na configuração do serviço e feche a tela.
7. Registre em `docs/segredos.md`: nome, onde está, data de criação. **Sem o valor.**

Lembre: o token envia por **qualquer** domínio ativado no Email Sending da conta (hoje só `mail.survivusmc.com`). Ver o risco aceito no `CLAUDE.md`.

## nLogin

Fonte: [modelo de configuração do nLogin](https://docs.nickuc.com/nlogin/config/template/). Confira de novo na hora de configurar: as chaves podem mudar entre versões.

**Antes de criar o token `smtp-nlogin`:** confirme que a recuperação de conta por e-mail funciona na versão do nLogin instalada (a premium, que tem essa função). Sem isso confirmado, o token não é criado.

**Cota e limites.** Os 200 envios por dia são da **conta inteira** (nLogin, NodeBB e o webmail dividem). Ao configurar, verifique no nLogin:

- se existe cooldown ou limite de recuperação por jogador ou por IP. **Sem cooldown**, qualquer um esgota a cota pedindo recuperação em loop. Nesse caso, faça o relay interno (`docs/progresso.md`, "Depois") antes de colocar o nLogin no ar;
- se a opção de SSL aceita um certificado interno (autoassinado ou de uma CA própria). O relay, se for preciso, usa um certificado desses.

Arquivo: `plugins/nLogin/config.yml` no servidor Minecraft, gerenciado pelo Crafty. Ele vai guardar o token.

**Dono do arquivo.** Antes do `chmod 600`, confira com `stat` se o dono do `config.yml` é o mesmo usuário com que o servidor roda dentro do container do Crafty. Senão, depois do `chmod 600`, o nLogin não consegue ler o arquivo. A referência é o `logs/latest.log`, criado pelo próprio servidor: ele tem o dono certo, com ou sem `userns-remap` no Docker.

```sh
# Os dois têm de mostrar o mesmo UID:GID
stat -c '%u:%g %a %n' <pasta do servidor>/plugins/nLogin/config.yml <pasta do servidor>/logs/latest.log
```

Se forem iguais, aplique `chmod 600`. Se forem diferentes, pare e corrija o dono antes. Comandos com `sudo` ou `docker` seguem a regra 3 do `CLAUDE.md`.

**Onde mais o token aparece:**

- no editor de arquivos do painel do Crafty: quem acessa o painel vê o token;
- em todo backup do servidor, em `/mnt/backup/crafty`. **Backup copiado para fora do servidor = rotacionar o token.**

Nunca em print de tela.

Trecho da seção de e-mail (os nomes das chaves seguem o modelo oficial):

```yaml
email:
  enable: true
  authentication:
    email: "nao-responda@mail.survivusmc.com"
    user: "api_token"
    password: "<token smtp-nlogin, colado direto aqui>"
  charset: "UTF-8"
  mimetype: "text/html"
  host: "smtp.mx.cloudflare.net"
  port: 465
  encryption: SSL
  debug: false
```

- `debug: true` só durante o teste, e volte para `false`: o log de depuração pode mostrar a conversa SMTP.
- O e-mail no nLogin serve para recuperar a conta e para 2FA.

### Teste obrigatório ao configurar

O código de recuperação do nLogin é uma mensagem curta e automática, igual à do teste da Etapa 4. Nesse teste, o Outlook pôs a mensagem no **lixo eletrônico** (SCL 5) mesmo com SPF, DKIM e DMARC passando. O Gmail entregou na caixa de entrada.

Ao configurar o nLogin:

1. Faça uma recuperação **real** de senha para uma conta **Hotmail/Outlook** e outra **Gmail**.
2. Use contas que **nunca** receberam nada de `mail.survivusmc.com` nem marcaram "Não é spam". Marcar ensina o filtro só daquela conta e esconde o problema.
3. Anote aqui, com a data, onde cada uma caiu (caixa de entrada ou lixo).
4. Se cair no lixo, avise os jogadores na tela de recuperação para olhar a pasta de spam.

| Data | Provedor | Resultado |
|---|---|---|
| | Outlook/Hotmail | |
| | Gmail | |

## NodeBB (para quando for instalado)

No painel admin do NodeBB: **Settings › Email**.

- Remetente: `forum@mail.survivusmc.com`.
- Ative o SMTP personalizado, com os parâmetros comuns acima e o token `smtp-nodebb`.
- O token fica no banco do NodeBB: nada de dump do banco compartilhado.
- Confira que o *Email preview* de `mail.survivusmc.com` continua desligado (`docs/cloudflare-envio.md`). Ligado, a Cloudflare guarda por cerca de 7 dias o conteúdo dos e-mails do fórum.
- Teste com o botão de e-mail de teste do painel e repita o teste de entrega do nLogin (Outlook e Gmail, contas novas).

## Testar o SMTP sem o serviço

`scripts/smtp-test.sh` envia uma mensagem de texto curta. Use um token temporário (validade de 1 dia, só *Email Sending: Edit*), nunca o de um serviço.

```sh
# Grava o token sem ele aparecer na tela nem no histórico
install -m 600 /dev/null ~/.config/cloudflare/smtp-teste.env
read -rsp 'Token: ' t; echo
printf 'SMTP_TOKEN=%s\n' "$t" > ~/.config/cloudflare/smtp-teste.env
unset t

scripts/smtp-test.sh ~/.config/cloudflare/smtp-teste.env nao-responda@mail.survivusmc.com <destino>
```

Respostas:

- `250`: aceito. Confira a entrega no Activity log (**Compute › Email Service › Activity log**). Confira SPF, DKIM e DMARC nos cabeçalhos da **mensagem recebida** (no Gmail: "Mostrar original"), não na prévia do painel: o *Email preview* fica desligado.
- `535`: token errado, expirado ou revogado.
- `550`: o domínio do remetente não está ativado no Email Sending.

Depois do teste: revogue o token e apague o arquivo (`rm ~/.config/cloudflare/smtp-teste.env`).

## Rotação

- A cada 6 meses, ou na hora se houver suspeita.
- Crie o token novo, troque na configuração do serviço, teste uma recuperação real, revogue o antigo.
- Atualize a data em `docs/segredos.md`.
- Envio que você não fez no Activity log ou nos relatórios DMARC = suspeita: revogue o token na hora.

# Segredos

Este documento lista **onde** cada segredo vive. **Nunca** coloque valores aqui.

## Onde vive cada segredo

| Segredo                                         | Onde vive                                                                                 | Nunca                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Secrets do Worker (tokens da API interna, etc.) | `wrangler secret put`                                                                     | Em `wrangler.toml` ou em qualquer arquivo commitado                         |
| Desenvolvimento local do Worker                 | `apps/mail-core/.dev.vars`                                                                | Commitado                                                                   |
| Config do webmail em produção                   | `/srv/webmail/.env` no servidor, dono `root`, `chmod 600`, lido via `env_file` do compose | Dentro do repositório, dentro da imagem Docker, em pasta servida pelo Nginx |
| Token do Cloudflare Tunnel                      | `/srv/cloudflared/.env`, `chmod 600`                                                      | Em compose commitado ou em linha de comando visível no `ps`                 |
| Token da Cloudflare para Wrangler (deploy)      | Variável de ambiente da sessão ou arquivo `chmod 600` fora do repositório                 | Em `.bashrc` compartilhado ou commitado                                     |
| Token SMTP do nLogin                            | Config do nLogin no servidor Minecraft, arquivo legível só pelo usuário do servidor       | Reaproveitado; em print de tela, log ou backup público                      |
| Token SMTP do NodeBB                            | Painel admin do NodeBB (fica no banco do NodeBB)                                          | Reaproveitado; em print de tela ou dump de banco compartilhado              |

## Inventário

Atualize a cada segredo criado ou rotacionado. **Sem valores.**

| Nome | Local | Quem usa | Permissões | Última rotação |
| ---- | ----- | -------- | ---------- | -------------- |
|      |       |          |            |                |

Tokens SMTP: rotação a cada 6 meses, ou na hora em caso de suspeita.

## Gerar um segredo forte

```sh
openssl rand -base64 32
```

Gere direto no terminal e cole direto no destino (`wrangler secret put`, arquivo `.env` do servidor). Nunca num chat, bloco de notas ou mensagem.

## Criar um arquivo de segredo com a permissão correta

Crie o arquivo **já** com permissão 600, antes de escrever qualquer coisa nele:

```sh
sudo install -m 600 -o root -g root /dev/null /srv/webmail/.env
sudo nano /srv/webmail/.env
```

Criar o arquivo e só depois rodar `chmod` deixa uma janela em que ele fica legível por outros usuários.

## Se um segredo vazar

1. **Revogue primeiro.** Apague ou rotacione o token no painel da Cloudflare (ou onde ele foi emitido) imediatamente.
2. Crie um novo e configure no serviço.
3. **Depois** investigue: como vazou, se foi usado (logs de entrega do Email Sending, relatórios DMARC, logs do Worker).
4. Registre a rotação no inventário acima.

**Apagar o segredo do histórico do git não resolve.** Num repositório público, ele já foi copiado por robôs que varrem o GitHub em minutos. O segredo é público a partir do push: só a revogação o torna inútil.

## Regra para os outros sites no Nginx

Os outros sites do servidor (rede `sites`) seguem estas regras:

- Bloquear arquivos ocultos em todo `server`:

  ```nginx
  location ~ /\. { deny all; }
  ```

- Manter `.env` e qualquer arquivo de configuração **fora** da pasta pública (`root`). O bloqueio acima é a segunda linha de defesa, não a primeira.

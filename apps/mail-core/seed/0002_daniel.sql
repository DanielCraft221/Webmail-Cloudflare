-- First user: daniel (admin), reading the three survivus.com.br mailboxes.
-- Neither the username nor the id is a secret. Idempotent: safe to run more than once.
INSERT OR IGNORE INTO users (id, username, display_name, role)
VALUES ('b2a98933-aa45-4af9-b0f3-dd58c4283e7b', 'daniel', 'Daniel', 'admin');

INSERT OR IGNORE INTO user_mailboxes (user_id, mailbox_id, can_read)
SELECT 'b2a98933-aa45-4af9-b0f3-dd58c4283e7b', id, 1 FROM mailboxes
WHERE address IN ('contato@survivus.com.br', 'suporte@survivus.com.br', 'compras@survivus.com.br');

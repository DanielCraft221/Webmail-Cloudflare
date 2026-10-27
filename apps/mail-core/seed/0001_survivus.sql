-- Initial data: survivus.com.br and its public contact mailboxes.
-- Idempotent: safe to run more than once.
INSERT OR IGNORE INTO domains (name) VALUES ('survivus.com.br');

INSERT OR IGNORE INTO mailboxes (address, domain_id, display_name)
SELECT 'contato@survivus.com.br', id, 'Contato' FROM domains WHERE name = 'survivus.com.br';

INSERT OR IGNORE INTO mailboxes (address, domain_id, display_name)
SELECT 'suporte@survivus.com.br', id, 'Suporte' FROM domains WHERE name = 'survivus.com.br';

INSERT OR IGNORE INTO mailboxes (address, domain_id, display_name)
SELECT 'compras@survivus.com.br', id, 'Compras' FROM domains WHERE name = 'survivus.com.br';

-- Falhas de login "perdoadas" quando a equipe master libera uma rede (IP) ou conta travada no painel.
-- A linha continua no histórico de acessos (auditoria); só deixa de contar para o travamento por tentativas.
ALTER TABLE log_acessos ADD COLUMN liberado_em timestamptz;

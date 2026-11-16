-- "Desfaz" a 0014_cme_caixa_sem_maquina.sql. Ela só corrigiu dados (não há como voltar ao estado errado),
-- então aqui apenas se retira o registro de que foi aplicada.
BEGIN;
DELETE FROM schema_migrations WHERE filename = '0014_cme_caixa_sem_maquina.sql';
COMMIT;

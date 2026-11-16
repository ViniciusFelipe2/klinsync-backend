-- Módulo CME: correção de dados. Caixa retirada de uma carga (ou de carga cancelada em teste) ficava
-- "na esterilização" sem estar em máquina nenhuma. A API agora devolve a caixa ao setor anterior;
-- esta migration conserta as que já tinham ficado assim, voltando cada uma ao último setor antes da máquina.
-- Não muda a estrutura do banco. Para desfazer: migrations/down/0014_cme_caixa_sem_maquina.down.sql.

UPDATE cme_caixas cx
   SET local = ant.setor, local_desde = ant.created_at, local_sala_id = ant.sala_id
  FROM (
    SELECT DISTINCT ON (caixa_id) caixa_id, setor, sala_id, created_at
      FROM cme_movimentos WHERE setor <> 'esterilizacao' ORDER BY caixa_id, created_at DESC
  ) ant
 WHERE cx.codigo_id = ant.caixa_id AND cx.local = 'esterilizacao' AND cx.local_carga_id IS NULL;

-- As que nunca tinham sido bipadas em outro setor voltam a ficar sem movimentação.
UPDATE cme_caixas SET local = NULL, local_desde = NULL WHERE local = 'esterilizacao' AND local_carga_id IS NULL;

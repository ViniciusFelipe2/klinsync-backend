-- A remontagem não é uma etapa própria: a montagem da próxima cirurgia acontece dentro da enfermagem.
-- O valor continua existindo nos tipos só para não quebrar registros antigos.
UPDATE features SET descricao = 'Ciclo de enfermagem (desmontagem e montagem da próxima cirurgia) e limpeza das salas cirúrgicas, com status de sala parada/liberada.'
 WHERE chave = 'giro_de_sala';

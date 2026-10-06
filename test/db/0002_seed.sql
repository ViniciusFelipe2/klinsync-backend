-- Dados de referência (módulos do KlinSync e política de segurança padrão).
INSERT INTO features (chave, nome_exibicao, descricao) VALUES
  ('checkin_cirurgioes', 'Check-In Secure',
   'Check-in e sincronização da chegada dos cirurgiões ao centro cirúrgico.'),
  ('giro_de_sala', 'Surgical Room Flow',
   'Ciclo de desmontagem, limpeza e remontagem das salas cirúrgicas, com status de sala parada/liberada.')
ON CONFLICT (chave) DO NOTHING;

INSERT INTO config_seguranca (id) VALUES (true) ON CONFLICT DO NOTHING;

-- Privilégios mínimos da role da aplicação (klinsync_app).
--
-- Dono dos objetos (migrations, DDL): klinsync_owner, que só existe como role de grupo e é assumida pelo migrate.sh
-- (SET ROLE). A API conecta como klinsync_app e só faz DML: se a API for comprometida, não consegue apagar tabelas,
-- alterar o schema, desligar triggers nem reescrever a trilha de auditoria.
--
-- Em bancos sem a role klinsync_app (testes locais, PGlite) a migration não faz nada.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'klinsync_app') THEN
    RETURN;
  END IF;

  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM klinsync_app;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM klinsync_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO klinsync_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO klinsync_app;

  -- Trilha de auditoria: a API acrescenta e (expurgo LGPD por data) apaga, mas nunca altera um registro.
  REVOKE UPDATE ON log_acoes_sensiveis, tenant_features_historico FROM klinsync_app;
END
$$;

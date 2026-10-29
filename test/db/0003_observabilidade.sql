-- Métricas da API por minuto e rota (alimenta a aba "Observabilidade" do painel master).
-- Cada processo da API acumula em memória e grava em lote; o upsert soma, então vale entre todas as instâncias do PM2.
CREATE TABLE metricas_api (
  minuto timestamptz NOT NULL,
  metodo text NOT NULL,
  rota text NOT NULL,
  requisicoes integer NOT NULL DEFAULT 0,
  erros_4xx integer NOT NULL DEFAULT 0,
  erros_5xx integer NOT NULL DEFAULT 0,
  lentas integer NOT NULL DEFAULT 0,          -- respostas acima de 1 s
  soma_ms bigint NOT NULL DEFAULT 0,
  max_ms integer NOT NULL DEFAULT 0,
  PRIMARY KEY (minuto, metodo, rota)
);
CREATE INDEX metricas_api_rota_idx ON metricas_api (rota, minuto DESC);

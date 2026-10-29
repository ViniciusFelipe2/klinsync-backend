-- Tolerância na rotação do refresh token: se a resposta da renovação se perder (Wi-Fi instável de tablet),
-- reapresentar o token recém-trocado dentro de poucos segundos não derruba a sessão inteira.
ALTER TABLE refresh_tokens ADD COLUMN rotacionado_em timestamptz;

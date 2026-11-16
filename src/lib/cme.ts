import type { Queryable } from "../db/index.js";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { LIMITES_PADRAO, TAMANHO_PADRAO_MM, gerarCodigoCurto, matrizDoConteudo, normalizarLeitura, type LimitesLeitura, type TipoCodigo } from "./datamatrix.js";
import { exigirModulo } from "./modulo.js";
import type { Perfil } from "./perfil.js";

export type TipoContaCme = "chefe" | "colaborador" | "estacao_sala" | "painel_setor" | "estacao_cme";

export type AcessoCme = { perfil: Perfil; tenantId: string | null; tipo: TipoContaCme | null; salaId: string | null };

/** Módulo liberado + função do login no CME. Administrador do hospital e master não têm função: só leem. */
export async function acessoCme(q: Queryable, userId: string): Promise<AcessoCme> {
  const { perfil, tenantId } = await exigirModulo(q, userId, "cme");
  if (perfil.role !== "operador") return { perfil, tenantId, tipo: null, salaId: null };
  const r = await q.query<{ tipo: TipoContaCme; sala_id: string | null }>(
    "SELECT tipo, sala_id FROM cme_contas WHERE usuario_id = $1 AND tenant_id = $2",
    [perfil.id, tenantId],
  );
  const conta = r.rows[0];
  if (!conta) throw forbidden("Este login ainda não tem uma função definida no CME. Fale com a equipe KlinSync.");
  return { perfil, tenantId, tipo: conta.tipo, salaId: conta.sala_id };
}

/** Consultas dos cadastros e relatórios. Computadores de sala e do CME e a TV de setor não enxergam estes dados. */
export async function exigirLeituraCme(q: Queryable, userId: string): Promise<AcessoCme> {
  const acesso = await acessoCme(q, userId);
  if (acesso.tipo === "estacao_sala" || acesso.tipo === "estacao_cme" || acesso.tipo === "painel_setor") throw forbidden();
  return acesso;
}

/** Cadastrar, gerar, imprimir, exportar e configurar: só o chefe do CME. */
export async function exigirChefeCme(q: Queryable, userId: string): Promise<AcessoCme & { tenantId: string }> {
  const acesso = await acessoCme(q, userId);
  if (acesso.tipo !== "chefe" || !acesso.tenantId) throw forbidden("Somente o chefe do CME pode fazer esta operação.");
  return acesso as AcessoCme & { tenantId: string };
}

/** Bipar na tela de teste: equipe do CME. Administrador e master acompanham sem registrar leituras. */
export async function exigirEquipeCme(q: Queryable, userId: string): Promise<AcessoCme & { tenantId: string }> {
  const acesso = await acessoCme(q, userId);
  if ((acesso.tipo !== "chefe" && acesso.tipo !== "colaborador") || !acesso.tenantId) throw forbidden("Somente a equipe do CME pode registrar leituras.");
  return acesso as AcessoCme & { tenantId: string };
}

/** Telas da sala cirúrgica: só o computador cadastrado pela equipe master para aquela sala. */
export async function exigirEstacaoSala(q: Queryable, userId: string): Promise<AcessoCme & { tenantId: string; salaId: string }> {
  const acesso = await acessoCme(q, userId);
  if (acesso.tipo !== "estacao_sala" || !acesso.tenantId || !acesso.salaId) throw forbidden("Esta tela só abre no computador da sala cirúrgica.");
  return acesso as AcessoCme & { tenantId: string; salaId: string };
}

export type Estacao = AcessoCme & { tenantId: string; tipo: "estacao_sala" | "estacao_cme" };

/** Telas de crachá: o computador de uma sala cirúrgica ou o computador do CME. */
export async function exigirEstacao(q: Queryable, userId: string): Promise<Estacao> {
  const acesso = await acessoCme(q, userId);
  const sala = acesso.tipo === "estacao_sala" && !!acesso.salaId;
  if ((!sala && acesso.tipo !== "estacao_cme") || !acesso.tenantId) throw forbidden("Esta tela só abre no computador da sala cirúrgica ou do CME.");
  return acesso as Estacao;
}

/** Telas de dentro do CME (expurgo, preparo, esterilização): só o computador do CME. */
export async function exigirEstacaoCme(q: Queryable, userId: string): Promise<Estacao> {
  const acesso = await exigirEstacao(q, userId);
  if (acesso.tipo !== "estacao_cme") throw forbidden("Esta tela só abre no computador do CME.");
  return acesso;
}

export type ConfigCme = LimitesLeitura & {
  tamanhoPadraoMm: number;
  tamanhoCrachaMm: number;
  /** Modo de teste: aceita o número do crachá digitado. Desligado, só o leitor serve. */
  permitirCrachaDigitado: boolean;
};

export const TAMANHO_CRACHA_PADRAO_MM = 12;

/** Configuração do hospital; sem linha salva (ou para o master, que não tem hospital) valem os padrões. */
export async function configCme(q: Queryable, tenantId: string | null): Promise<ConfigCme> {
  const r = tenantId
    ? await q.query<{
        tamanho_padrao_mm: number;
        modulo_minimo_mm: number;
        modulo_aviso_mm: number;
        matriz_maxima_5mm: number;
        tamanho_cracha_mm: number;
        permitir_cracha_digitado: boolean;
      }>(
        `SELECT tamanho_padrao_mm, modulo_minimo_mm, modulo_aviso_mm, matriz_maxima_5mm, tamanho_cracha_mm, permitir_cracha_digitado
           FROM cme_config WHERE tenant_id = $1`,
        [tenantId],
      )
    : { rows: [] };
  const c = r.rows[0];
  if (!c) return { ...LIMITES_PADRAO, tamanhoPadraoMm: TAMANHO_PADRAO_MM, tamanhoCrachaMm: TAMANHO_CRACHA_PADRAO_MM, permitirCrachaDigitado: false };
  return {
    tamanhoPadraoMm: c.tamanho_padrao_mm,
    moduloMinimoMm: c.modulo_minimo_mm,
    moduloAvisoMm: c.modulo_aviso_mm,
    matrizMaxima5mm: c.matriz_maxima_5mm,
    tamanhoCrachaMm: c.tamanho_cracha_mm,
    permitirCrachaDigitado: c.permitir_cracha_digitado,
  };
}

/** Grava na trilha de auditoria do CME (a tabela só aceita INSERT). Nunca colocar dados pessoais em `detalhes`. */
export async function auditarCme(
  q: Queryable,
  a: { tenantId: string; usuarioId: string; ip: string | undefined; acao: string; detalhes?: Record<string, unknown> },
): Promise<void> {
  await q.query("INSERT INTO cme_auditoria (tenant_id, usuario_id, ip, acao, detalhes) VALUES ($1, $2, $3, $4, $5::jsonb)", [
    a.tenantId,
    a.usuarioId,
    a.ip ?? null,
    a.acao,
    JSON.stringify(a.detalhes ?? {}),
  ]);
}

/* ---------------------------------------- Códigos ---------------------------------------- */

export type CodigoLinha = {
  id: string;
  tipo: TipoCodigo;
  rotulo: string;
  codigo: string;
  origem: "gerado" | "existente";
  matriz_lado: number;
  ativo: boolean;
  created_at: string;
};

export const COLUNAS_CODIGO = "id, tipo, rotulo, codigo, origem, matriz_lado, ativo, created_at";
const MAX_TENTATIVAS_DE_CODIGO_LIVRE = 5;

/** Código já gravado na peça, como o leitor o entrega. */
export function codigoGravadoValido(texto: string): string {
  const codigo = normalizarLeitura(texto);
  if (!/^[\x20-\x7e]{1,200}$/.test(codigo)) throw unprocessable("Informe o código exatamente como está na peça: até 200 letras, números ou símbolos comuns.");
  return codigo;
}

/** Cria o código de um item ou de uma caixa: gerado pelo sistema ou, se informado, o que já está gravado na peça. */
export async function criarCodigo(
  q: Queryable,
  a: { tenantId: string; usuarioId: string; ip: string | undefined; tipo: TipoCodigo; rotulo: string; codigoGravado?: string | undefined },
): Promise<CodigoLinha> {
  const inserir = (codigo: string, origem: "gerado" | "existente") =>
    q.query<CodigoLinha>(
      `INSERT INTO cme_codigos (tenant_id, tipo, rotulo, codigo, origem, matriz_lado, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (tenant_id, codigo) DO NOTHING RETURNING ${COLUNAS_CODIGO}`,
      [a.tenantId, a.tipo, a.rotulo, codigo, origem, matrizDoConteudo(codigo).length, a.usuarioId],
    );

  let criado: CodigoLinha | undefined;
  if (a.codigoGravado !== undefined) {
    criado = (await inserir(codigoGravadoValido(a.codigoGravado), "existente")).rows[0];
    if (!criado) throw conflict("Este código já está cadastrado.");
  } else {
    for (let i = 0; i < MAX_TENTATIVAS_DE_CODIGO_LIVRE && !criado; i++) criado = (await inserir(gerarCodigoCurto(a.tipo), "gerado")).rows[0];
    if (!criado) throw conflict("Não foi possível gerar um código livre. Tente novamente.");
  }
  await auditarCme(q, {
    tenantId: a.tenantId,
    usuarioId: a.usuarioId,
    ip: a.ip,
    acao: criado.origem === "gerado" ? "cme_codigo_gerado" : "cme_codigo_existente",
    detalhes: { id: criado.id, tipo: a.tipo },
  });
  return criado;
}

/* ---------------------------------------- Crachá ---------------------------------------- */

/**
 * Número do crachá como fica guardado e comparado: em maiúsculas, porque o leitor "digita" como um teclado
 * e o Caps Lock ligado no computador inverteria as letras.
 */
export function normalizarCracha(texto: string): string {
  return normalizarLeitura(texto).toUpperCase();
}

export const NUMERO_CRACHA = /^[A-Z0-9-]{4,30}$/;

/** Média por tecla abaixo disto não é digitação humana (o mesmo critério da tela). */
const MS_POR_TECLA_DO_LEITOR = 30;
const MIN_TECLAS_PARA_MEDIR = 4;

/**
 * Se a entrada chegou na velocidade de um leitor. É uma barreira contra digitar o número do crachá,
 * não uma garantia: para o computador, o leitor é só um teclado.
 */
export function pareceLeitor(duracaoMs: number | undefined, teclas: number | undefined): boolean {
  if (duracaoMs === undefined || teclas === undefined || teclas < MIN_TECLAS_PARA_MEDIR) return false;
  return duracaoMs / (teclas - 1) < MS_POR_TECLA_DO_LEITOR;
}

/* ---------------------------------------- Onde a caixa está ---------------------------------------- */

export type SetorCaixa = "sala" | "expurgo" | "preparo" | "esterilizacao" | "arsenal";
export type StatusCaixa = "sem_movimento" | "sala" | "expurgo" | "preparo" | "esterilizacao" | "arsenal";

/**
 * Status da caixa: o último setor em que foi bipada (cme_caixas cx). "sala" é a caixa contaminada, bipada na sala cirúrgica.
 * A esterilização é um status só, do bip na máquina até a confirmação do arsenal: o andamento do ciclo aparece na máquina.
 */
export const SQL_STATUS_CAIXA = "COALESCE(cx.local, 'sem_movimento')";

/**
 * Registra que a caixa foi bipada em um setor. O status só muda quando o lugar muda:
 * bipar de novo no mesmo setor (retomar a conferência, por exemplo) não mexe na hora nem no histórico.
 */
export async function moverCaixa(
  q: Queryable,
  a: { tenantId: string; caixaId: string; setor: SetorCaixa; salaId?: string | null; cargaId?: string | null; colaboradorId: string; estacaoId: string },
): Promise<void> {
  const salaId = a.setor === "sala" ? (a.salaId ?? null) : null;
  const cargaId = a.setor === "esterilizacao" ? (a.cargaId ?? null) : null;
  const atual = (
    await q.query<{ local: string | null; local_sala_id: string | null; local_carga_id: string | null }>(
      "SELECT local, local_sala_id, local_carga_id FROM cme_caixas WHERE codigo_id = $1 AND tenant_id = $2 FOR UPDATE",
      [a.caixaId, a.tenantId],
    )
  ).rows[0];
  if (!atual) return;
  if (atual.local === a.setor && atual.local_sala_id === salaId && atual.local_carga_id === cargaId) return;
  // Saiu de uma carga que ainda estava sendo montada: ela não vai mais naquele ciclo.
  if (atual.local_carga_id && atual.local_carga_id !== cargaId) {
    await q.query(
      "DELETE FROM cme_carga_caixas WHERE carga_id = $1 AND caixa_id = $2 AND EXISTS (SELECT 1 FROM cme_cargas g WHERE g.id = $1 AND g.status = 'montando')",
      [atual.local_carga_id, a.caixaId],
    );
  }
  await q.query("UPDATE cme_caixas SET local = $2, local_desde = now(), local_sala_id = $3, local_carga_id = $4 WHERE codigo_id = $1", [
    a.caixaId,
    a.setor,
    salaId,
    cargaId,
  ]);
  await q.query("INSERT INTO cme_movimentos (tenant_id, caixa_id, setor, sala_id, carga_id, colaborador_id, estacao_id) VALUES ($1, $2, $3, $4, $5, $6, $7)", [
    a.tenantId,
    a.caixaId,
    a.setor,
    salaId,
    cargaId,
    a.colaboradorId,
    a.estacaoId,
  ]);
}

/**
 * A caixa saiu da esterilização sem passar pelo ciclo (retirada da carga, ou carga cancelada em teste):
 * volta para o último setor em que esteve antes da máquina. Sem setor anterior, fica "sem movimentação".
 */
export async function devolverCaixa(q: Queryable, a: { tenantId: string; caixaId: string; colaboradorId: string; estacaoId: string }): Promise<void> {
  const anterior = (
    await q.query<{ setor: SetorCaixa; sala_id: string | null }>(
      "SELECT setor, sala_id FROM cme_movimentos WHERE caixa_id = $1 AND tenant_id = $2 AND setor <> 'esterilizacao' ORDER BY created_at DESC LIMIT 1",
      [a.caixaId, a.tenantId],
    )
  ).rows[0];
  if (anterior) {
    await moverCaixa(q, { ...a, setor: anterior.setor, salaId: anterior.sala_id });
    return;
  }
  await q.query("UPDATE cme_caixas SET local = NULL, local_desde = NULL, local_sala_id = NULL, local_carga_id = NULL WHERE codigo_id = $1 AND tenant_id = $2", [
    a.caixaId,
    a.tenantId,
  ]);
}

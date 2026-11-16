import { randomInt } from "node:crypto";
import bwipjs from "bwip-js";
import { unprocessable } from "../errors.js";

/** Limites do leitor em uso: mudam por configuração do hospital se o leitor for trocado. */
export type LimitesLeitura = {
  /** Abaixo disto o leitor não garante a leitura: a impressão é bloqueada. */
  moduloMinimoMm: number;
  /** Abaixo disto a leitura fica sem folga: a tela mostra um aviso. */
  moduloAvisoMm: number;
  /** Maior matriz aceita (quadradinhos por lado) em códigos de até 5 mm. */
  matrizMaxima5mm: number;
};

export const LIMITES_PADRAO: LimitesLeitura = { moduloMinimoMm: 0.17, moduloAvisoMm: 0.19, matrizMaxima5mm: 24 };
export const TAMANHO_PADRAO_MM = 5;
export const TAMANHO_MIN_MM = 3;
export const TAMANHO_MAX_MM = 15;
export const TAMANHOS_FOLHA_TESTE = [3, 4, 5, 6, 8, 10];
/** Margem branca obrigatória em volta do código, em quadradinhos. Fica por fora do tamanho do código. */
export const ZONA_SILENCIO_MODULOS = 1;

const MM_POR_MIL = 0.0254;
/** Até este tamanho vale o limite de matriz: acima dele só o tamanho do quadradinho decide. */
const TAMANHO_DO_LIMITE_DE_MATRIZ_MM = 5;

export type SituacaoCodigo = "ok" | "aviso" | "bloqueado";

export type AvaliacaoCodigo = {
  tamanhoMm: number;
  modulosPorLado: number;
  moduloMm: number;
  moduloMil: number;
  totalComMargemMm: number;
  situacao: SituacaoCodigo;
  mensagem: string | null;
};

/** Elimina o ruído de ponto flutuante (3,4 / 20 daria 0,16999...), que bloquearia um código exatamente no limite. */
const arredondar = (v: number, casas: number) => Number(v.toFixed(casas));
const mm = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 3 });

/** Calcula o quadradinho de um código e aplica os limites de aviso e de bloqueio. */
export function avaliarCodigo(modulosPorLado: number, tamanhoMm: number, limites: LimitesLeitura): AvaliacaoCodigo {
  const modulo = arredondar(tamanhoMm / modulosPorLado, 6);
  const base = {
    tamanhoMm,
    modulosPorLado,
    moduloMm: arredondar(modulo, 3),
    moduloMil: arredondar(modulo / MM_POR_MIL, 1),
    totalComMargemMm: arredondar(tamanhoMm + 2 * ZONA_SILENCIO_MODULOS * modulo, 3),
  };
  const matriz = `${modulosPorLado}x${modulosPorLado}`;

  if (tamanhoMm <= TAMANHO_DO_LIMITE_DE_MATRIZ_MM && modulosPorLado > limites.matrizMaxima5mm) {
    return {
      ...base,
      situacao: "bloqueado",
      mensagem: `Este conteúdo gera uma matriz de ${matriz}, maior que o limite de ${limites.matrizMaxima5mm}x${limites.matrizMaxima5mm} para códigos de até 5 mm. Encurte o conteúdo ou aumente o tamanho do código.`,
    };
  }
  if (modulo < limites.moduloMinimoMm) {
    return {
      ...base,
      situacao: "bloqueado",
      mensagem: `Impressão bloqueada: cada quadradinho teria ${mm(base.moduloMm)} mm, abaixo do mínimo de ${mm(limites.moduloMinimoMm)} mm que o leitor consegue ler. Aumente o tamanho do código ou encurte o conteúdo.`,
    };
  }
  if (modulo < limites.moduloAvisoMm) {
    return {
      ...base,
      situacao: "aviso",
      mensagem: `Atenção: cada quadradinho terá ${mm(base.moduloMm)} mm, abaixo da folga recomendada de ${mm(limites.moduloAvisoMm)} mm. A leitura pode falhar; teste antes de usar.`,
    };
  }
  return { ...base, situacao: "ok", mensagem: null };
}

/** Matriz do Data Matrix ECC 200 (correção de erro padrão), linha a linha, de cima para baixo. Sem margem. */
export function matrizDoConteudo(conteudo: string): boolean[][] {
  let simbolo: { pixs: number[]; pixx: number; pixy: number };
  try {
    simbolo = bwipjs.raw({ bcid: "datamatrix", text: conteudo })[0] as unknown as typeof simbolo;
  } catch {
    throw unprocessable("Este conteúdo não pode ser transformado em Data Matrix. Use só letras e números.");
  }
  const linhas: boolean[][] = [];
  for (let y = 0; y < simbolo.pixy; y++) {
    linhas.push(Array.from({ length: simbolo.pixx }, (_, x) => simbolo.pixs[y * simbolo.pixx + x] === 1));
  }
  return linhas;
}

/**
 * Tabela do algoritmo de Damm. Com ela, o último dígito do código denuncia qualquer dígito errado
 * e qualquer troca de dois dígitos vizinhos, os erros mais comuns ao digitar à mão.
 */
const DAMM = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

const digitoDamm = (digitos: string) => [...digitos].reduce((interino, d) => DAMM[interino]![Number(d)]!, 0);

/** Confere o dígito verificador de um código gerado pelo sistema. */
export const digitoVerificadorOk = (codigo: string) => /^\d+$/.test(codigo) && digitoDamm(codigo) === 0;

export type TipoCodigo = "item" | "caixa";

/**
 * Oito dígitos (matriz 12x12): tipo (1 caixa, 2 item), seis aleatórios e o verificador.
 * Só números porque o leitor age como teclado, e símbolos podem sair trocados conforme o layout do teclado do computador.
 */
export function gerarCodigoCurto(tipo: TipoCodigo): string {
  const corpo = `${tipo === "caixa" ? 1 : 2}${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;
  return `${corpo}${digitoDamm(corpo)}`;
}

/**
 * Deixa o texto recebido do leitor no formato usado na busca: sem caracteres invisíveis
 * e sem o prefixo de identificação de simbologia (]d1 a ]d6) que alguns leitores acrescentam.
 */
export function normalizarLeitura(texto: string): string {
  return texto
    .replace(/[\u0000-\u001f\u007f]/g, "") // eslint-disable-line no-control-regex
    .replace(/^\]d[1-6]/, "")
    .trim();
}

import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

const PERIODO = 30;

function criar(segredoBase32: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: "KlinSync",
    label,
    algorithm: "SHA1",
    digits: 6,
    period: PERIODO,
    secret: OTPAuth.Secret.fromBase32(segredoBase32),
  });
}

export function novoSegredoBase32(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export async function qrCodeDataUrl(segredoBase32: string, label: string): Promise<string> {
  return QRCode.toDataURL(criar(segredoBase32, label).toString(), { margin: 1, width: 256 });
}

/**
 * Valida o código (janela de ±1 passo) e impede reutilização: o passo aceito precisa ser maior
 * que o último já consumido por este fator.
 */
export function validarCodigo(
  segredoBase32: string,
  codigo: string,
  ultimoPasso: number,
): { ok: true; passo: number } | { ok: false } {
  if (!/^\d{6}$/.test(codigo)) return { ok: false };
  const delta = criar(segredoBase32, "x").validate({ token: codigo, window: 1 });
  if (delta === null) return { ok: false };
  const passo = Math.floor(Date.now() / 1000 / PERIODO) + delta;
  if (passo <= ultimoPasso) return { ok: false };
  return { ok: true, passo };
}

/** Gera o código atual (usado nos testes). */
export function codigoAtual(segredoBase32: string): string {
  return criar(segredoBase32, "x").generate();
}

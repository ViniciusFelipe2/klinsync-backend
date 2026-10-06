import bcrypt from "bcryptjs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

export const sha256Hex = (valor: string) => createHash("sha256").update(valor).digest("hex");

/** Token opaco (refresh token). */
export const tokenAleatorio = (bytes = 32) => randomBytes(bytes).toString("base64url");

const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Token de convite: legível, sem caracteres ambíguos, 32 caracteres. */
export function gerarTokenConvite(): string {
  let out = "";
  for (let i = 0; i < 32; i++) out += ALFABETO[randomInt(ALFABETO.length)];
  return out;
}

/* ---------------------------------- Senhas (scrypt) ---------------------------------- */

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

function scryptAsync(senha: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(senha.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: 128 * n * r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashSenha(senha: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(senha, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** Hash bcrypt (formato do Supabase Auth), aceito só para migração: é convertido para scrypt no primeiro login. */
export const ehHashLegado = (armazenado: string) => /^\$2[aby]\$\d{2}\$/.test(armazenado);

export async function verificarSenha(senha: string, armazenado: string): Promise<boolean> {
  if (ehHashLegado(armazenado)) return bcrypt.compare(senha, armazenado).catch(() => false);
  const partes = armazenado.split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = partes as [string, string, string, string, string, string];
  const esperado = Buffer.from(hashB64, "base64");
  const key = await scryptAsync(senha, Buffer.from(saltB64, "base64"), Number(n), Number(r), Number(p));
  return key.length === esperado.length && timingSafeEqual(key, esperado);
}

let hashFalso: Promise<string> | undefined;
/** Hash descartável para igualar o tempo de resposta quando o e-mail não existe. */
export function hashSenhaFalso(): Promise<string> {
  hashFalso ??= hashSenha(tokenAleatorio(16));
  return hashFalso;
}

/* ---------------------- Cifra simétrica (AES-256-GCM) para segredos TOTP ---------------------- */

export function chaveMfa(config: { MFA_ENCRYPTION_KEY?: string | undefined; JWT_REFRESH_SECRET: string }): Buffer {
  const base = config.MFA_ENCRYPTION_KEY ?? config.JWT_REFRESH_SECRET;
  return Buffer.from(hkdfSync("sha256", base, "klinsync", "mfa-totp", 32));
}

export function cifrar(texto: string, chave: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", chave, iv);
  const enc = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decifrar(payload: string, chave: Buffer): string {
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64url")) as [Buffer, Buffer, Buffer];
  const decipher = createDecipheriv("aes-256-gcm", chave, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

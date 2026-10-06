import { createHash } from "node:crypto";
import type { Config } from "../config.js";

/* ----------------------------------- reCAPTCHA v3 ----------------------------------- */

const SCORE_MINIMO = 0.5;
export type ResultadoCaptcha = { ok: boolean; motivo?: string; score?: number };

export async function verificarCaptchaGoogle(
  secret: string | undefined,
  token: string | null | undefined,
  acaoEsperada: string,
): Promise<ResultadoCaptcha> {
  if (!secret) return { ok: true, motivo: "desativado" };
  if (!token) return { ok: false, motivo: "sem-token" };
  try {
    const resp = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { ok: true, motivo: "indisponivel" };
    const corpo = (await resp.json()) as { success?: boolean; score?: number; action?: string };
    if (!corpo.success) return { ok: false, motivo: "invalido" };
    if (corpo.action && corpo.action !== acaoEsperada) return { ok: false, motivo: "acao" };
    const score = corpo.score ?? 0;
    if (score < SCORE_MINIMO) return { ok: false, motivo: "score-baixo", score };
    return { ok: true, score };
  } catch {
    // Indisponibilidade do serviço externo não pode derrubar o login legítimo.
    return { ok: true, motivo: "indisponivel" };
  }
}

/* ------------------------- Senha vazada (Have I Been Pwned, k-anonymity) ------------------------- */

export async function senhaFoiVazadaHibp(senha: string): Promise<boolean> {
  try {
    const hash = createHash("sha1").update(senha).digest("hex").toUpperCase();
    const prefixo = hash.slice(0, 5);
    const sufixo = hash.slice(5);
    const resp = await fetch(`https://api.pwnedpasswords.com/range/${prefixo}`, {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return false;
    for (const linha of (await resp.text()).split("\n")) {
      const [suf, cont] = linha.trim().split(":");
      if (suf === sufixo && Number(cont ?? 0) > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/* ------------------------------------ Geolocalização de IP ------------------------------------ */

async function consultar(url: string, ms = 2500): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const IP_PRIVADO = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/i;

export async function geolocalizarIpExterno(ip: string): Promise<string | null> {
  if (!ip || ip === "desconhecido" || IP_PRIVADO.test(ip)) return "Rede local";

  const a = await consultar(`https://ipwho.is/${encodeURIComponent(ip)}`);
  if (a && a["success"] === true) {
    const partes = [a["city"], a["region"], a["country"]].filter(Boolean).map(String);
    if (partes.length) return partes.join(", ");
  }
  const b = await consultar(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
  if (b && !b["error"]) {
    const partes = [b["city"], b["region"], b["country_name"]].filter(Boolean).map(String);
    if (partes.length) return partes.join(", ");
  }
  return null;
}

/* ---------------------------------------- Composição ---------------------------------------- */

export interface Externos {
  verificarCaptcha(token: string | null | undefined, acao: string): Promise<ResultadoCaptcha>;
  senhaFoiVazada(senha: string): Promise<boolean>;
  geolocalizarIp(ip: string): Promise<string | null>;
}

export function criarExternos(config: Config): Externos {
  return {
    verificarCaptcha: (token, acao) => verificarCaptchaGoogle(config.RECAPTCHA_SECRET_KEY, token, acao),
    senhaFoiVazada: (senha) => (config.HIBP_ENABLED ? senhaFoiVazadaHibp(senha) : Promise.resolve(false)),
    geolocalizarIp: (ip) => (config.GEOIP_ENABLED ? geolocalizarIpExterno(ip) : Promise.resolve(null)),
  };
}

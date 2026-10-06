import { SignJWT, jwtVerify } from "jose";

const ISSUER = "klinsync";
const enc = (s: string) => new TextEncoder().encode(s);

export type AccessClaims = { sub: string; email: string };

export async function assinarAccessToken(
  secret: string,
  claims: AccessClaims,
  ttlMin: number,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlMin * 60;
  const token = await new SignJWT({ email: claims.email, typ: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(enc(secret));
  return { token, expiresAt };
}

export async function verificarAccessToken(secret: string, token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, enc(secret), { issuer: ISSUER, algorithms: ["HS256"] });
  if (payload["typ"] !== "access" || !payload.sub) throw new Error("token inválido");
  return { sub: payload.sub, email: String(payload["email"] ?? "") };
}

/** Token curto emitido após a senha correta, a ser trocado pela sessão com o código TOTP. */
export async function assinarMfaToken(secret: string, claims: { sub: string; factorId: string }): Promise<string> {
  return new SignJWT({ typ: "mfa", factorId: claims.factorId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(enc(secret));
}

export async function verificarMfaToken(secret: string, token: string): Promise<{ sub: string; factorId: string }> {
  const { payload } = await jwtVerify(token, enc(secret), { issuer: ISSUER, algorithms: ["HS256"] });
  if (payload["typ"] !== "mfa" || !payload.sub || typeof payload["factorId"] !== "string") {
    throw new Error("token inválido");
  }
  return { sub: payload.sub, factorId: payload["factorId"] };
}

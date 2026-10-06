/** Erro com status HTTP e mensagem segura para o usuário (o front exibe `message` diretamente). */
export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown> | undefined;

  constructor(status: number, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const unauthorized = (m = "Sessão inválida ou expirada.") => new HttpError(401, m);
export const forbidden = (m = "Sem permissão para esta operação.") => new HttpError(403, m);
export const notFound = (m = "Registro não encontrado.") => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);
export const unprocessable = (m: string) => new HttpError(422, m);
export const tooMany = (m: string) => new HttpError(429, m);
export const locked = (m: string, extra: Record<string, unknown>) => new HttpError(423, m, extra);
export const unavailable = (m: string) => new HttpError(503, m);

export const MSG_GENERICA = "Não foi possível concluir a operação. Tente novamente.";

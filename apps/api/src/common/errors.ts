/** A domain error with an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);

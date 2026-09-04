export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public detail?: unknown
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, detail?: unknown) =>
  new HttpError(400, 'invalid_request', msg, detail);
export const unauthorized = (msg = '로그인이 필요합니다.') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = '권한이 없습니다.') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = '찾을 수 없습니다.') => new HttpError(404, 'not_found', msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);

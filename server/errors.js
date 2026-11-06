/** An error carrying an HTTP status and a message that is safe to show to the user. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const badRequest = (msg) => new HttpError(400, msg);
export const notFound = (msg) => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);
export const unavailable = (msg) => new HttpError(503, msg);

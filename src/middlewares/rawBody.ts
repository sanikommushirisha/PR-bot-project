import type { Request } from "express";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

/** Pass as the `verify` option to express.json()/express.urlencoded() to stash the raw body needed for HMAC signature checks — parsing consumes the stream, so it must be captured before that happens. */
export function saveRawBody(req: Request, _res: unknown, buf: Buffer): void {
  req.rawBody = buf;
}

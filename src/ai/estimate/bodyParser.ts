import express from 'express';

/**
 * MONTH2_SPEC m2.2 §11.3: the body handling of POST /api/ai/estimate, kept apart from estimate.ts so src/app.ts can mount it without
 * loading the AI layer (catalog, i18n tables) when AI is off.
 */

export const ESTIMATE_PATH = '/api/ai/estimate';
/** §11.3: the body limit of this route (its own parser runs before the app's global 25 MB JSON parser). */
export const ESTIMATE_BODY_LIMIT = '64kb';

/**
 * The route's own JSON parser (64 KB) and its error answers: entity.too.large → 413 TOO_LARGE, unreadable JSON → 400 BAD_REQUEST.
 * src/app.ts mounts it for ESTIMATE_PATH BEFORE the global 25 MB parser (body-parser then skips the parsed body); the AI router mounts
 * it on the route too, for module-only apps (tests).
 */
export function estimateJsonParser(): express.RequestHandler[] {
  const parse = express.json({ limit: ESTIMATE_BODY_LIMIT });
  const errors: express.ErrorRequestHandler = (err, _req, res, next) => {
    if (!err) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (err.type === 'entity.too.large' || err.status === 413) return res.status(413).json({ ok: false, error: 'TOO_LARGE' });
    return res.status(400).json({ ok: false, error: 'BAD_REQUEST', field: 'body' });
  };
  return [parse, errors as unknown as express.RequestHandler];
}

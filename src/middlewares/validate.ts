import { Request, Response, NextFunction } from 'express';
import { AnyZodObject } from 'zod';

/**
 * Validates a request against a Zod schema — and then USES the parsed result.
 *
 * It used to parse and throw the result away, so the schema only ever rejected;
 * it never shaped. Unknown fields sailed through to the controller (a PATCH could
 * set any column it liked) and `.default()` values were never applied.
 *
 * Only the parts the schema declares are replaced: a schema with just `body`
 * leaves `req.query` and `req.params` exactly as Express produced them.
 */
export const validateRequest = (schema: AnyZodObject) => {
  const shape = ((schema as any).shape ?? {}) as Record<string, unknown>;

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    let parsed: any;
    try {
      parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params,
      });
    } catch (error) {
      return next(error);
    }

    if ('body' in shape) req.body = parsed.body;
    /* Express 4 exposes query/params as plain properties, so assigning is safe;
       only replace them when the schema actually describes them. */
    if ('query' in shape) (req as any).query = parsed.query;
    if ('params' in shape) req.params = parsed.params;

    /* Outside the try: an error thrown by a later handler is that handler's
       failure, not a validation failure, and must not be caught here. */
    next();
  };
};

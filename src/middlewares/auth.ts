import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { AuthTokenPayload, Role } from '../types/index.js';
import { AppError } from './errorHandler.js';
import { store } from '../data/store.js';
import { runWithRequestContext } from '../utils/request-context.js';

export interface AuthenticatedRequest extends Request {
  user?: AuthTokenPayload;
}

/**
 * Async because the user lookup is. `getUserById` returns a Promise, and a
 * Promise is always truthy — without the await, the token of a deleted user
 * kept working until it expired.
 *
 * Express 4 does not catch a rejected promise from a handler, so every failure
 * goes through `next` rather than being thrown. `next()` itself is called
 * outside the try: inside it, any synchronous error from a later handler was
 * caught here and misreported as "Invalid authentication token".
 */
export const authenticateJWT = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AppError('Authentication token required', 401));
  }

  const token = authHeader.split(' ')[1];

  let decoded: AuthTokenPayload;
  try {
    decoded = jwt.verify(token, config.jwtSecret) as AuthTokenPayload;

    const user = await store.getUserById(decoded.userId);
    if (!user) {
      throw new AppError('User belonging to this token no longer exists', 401);
    }
  } catch (err: any) {
    if (err instanceof AppError) {
      return next(err);
    }
    if (err?.name === 'TokenExpiredError') {
      return next(new AppError('Token has expired, please log in again', 401));
    }
    return next(new AppError('Invalid authentication token', 401));
  }

  req.user = decoded;
  /* Everything downstream of this call — controllers, services, Mongoose hooks
     — can read who is acting, which is what fills created_by / updated_by. */
  runWithRequestContext({ user_id: decoded.userId, role: decoded.role }, () => next());
};

export const requireRoles = (...allowedRoles: Role[]) => {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AppError('Unauthorized', 401));
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action', 403));
    }

    next();
  };
};

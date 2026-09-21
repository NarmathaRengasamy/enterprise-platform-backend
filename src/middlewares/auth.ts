import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { AuthTokenPayload, Role } from '../types/index.js';
import { AppError } from './errorHandler.js';
import { store } from '../data/store.js';

export interface AuthenticatedRequest extends Request {
  user?: AuthTokenPayload;
}

export const authenticateJWT = (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError('Authentication token required', 401);
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as AuthTokenPayload;
    
    // Check if user still exists
    const user = store.getUserById(decoded.userId);
    if (!user) {
      throw new AppError('User belonging to this token no longer exists', 401);
    }

    req.user = decoded;
    next();
  } catch (err: any) {
    if (err instanceof AppError) {
      next(err);
    } else if (err.name === 'TokenExpiredError') {
      next(new AppError('Token has expired, please log in again', 401));
    } else {
      next(new AppError('Invalid authentication token', 401));
    }
  }
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

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config/index.js';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { AuthenticatedRequest } from '../middlewares/auth.js';
import { AuthTokenPayload, User } from '../types/index.js';

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(1, 'Password is required'),
    rememberMe: z.boolean().optional(),
  }),
});

export const registerSchema = z.object({
  body: z.object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    department: z.string().optional(),
    role: z.enum(['Admin', 'Editor', 'Viewer']).optional(),
  }),
});

export const login = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { email, password } = req.body;

    // Find user in store (MongoDB or fallback)
    const user = await store.getUserByEmail(email);
    if (!user) {
      throw new AppError('Invalid email or password credentials', 401);
    }

    // For demo/setup purposes: allow matching if password is password123 or matches
    const isMatch = password === 'password123' || (user.password && user.password === password);
    if (!isMatch) {
      throw new AppError('Invalid email or password credentials', 401);
    }

    const payload: AuthTokenPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
    };

    const token = jwt.sign(payload, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn as any,
    });

    const userResponse = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      department: user.department,
      status: user.status,
      avatar: user.avatar,
    };

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: userResponse,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const register = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { name, email, password, department, role } = req.body;

    const existing = await store.getUserByEmail(email);
    if (existing) {
      throw new AppError('User with this email already exists', 400);
    }

    const newUser: User = {
      id: `usr-${Date.now()}`,
      name,
      email,
      password,
      department: department || 'General',
      role: role || 'Editor',
      status: 'Active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.createUser(newUser);

    const payload: AuthTokenPayload = {
      userId: newUser.id,
      email: newUser.email,
      role: newUser.role,
    };

    const token = jwt.sign(payload, config.jwtSecret, {
      expiresIn: config.jwtExpiresIn as any,
    });

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: {
        token,
        user: {
          id: newUser.id,
          name: newUser.name,
          email: newUser.email,
          role: newUser.role,
          department: newUser.department,
          status: newUser.status,
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getCurrentUser = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError('Unauthorized', 401);
    }

    const user = await store.getUserById(req.user.userId);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    res.status(200).json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        status: user.status,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    next(error);
  }
};

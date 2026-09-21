import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { User, Role } from '../types/index.js';

export const addMemberSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Valid email is required'),
    department: z.string().optional().default('Operations'),
    role: z.enum(['Admin', 'Editor', 'Viewer']).optional().default('Editor'),
    avatar: z.string().optional().default(''),
  }),
});

export const updateMemberSchema = z.object({
  body: z.object({
    name: z.string().optional(),
    department: z.string().optional(),
    role: z.enum(['Admin', 'Editor', 'Viewer']).optional(),
    status: z.enum(['Active', 'Pending', 'Inactive']).optional(),
  }),
});

export const getTeamMembers = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { search, role, status } = req.query;
    const users = await store.getUsers();
    let members = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      department: u.department,
      role: u.role,
      status: u.status,
      avatar: u.avatar,
    }));

    if (role && role !== 'All') {
      members = members.filter((m) => m.role === role);
    }
    if (status && status !== 'All') {
      members = members.filter((m) => m.status === status);
    }
    if (search) {
      const q = (search as string).toLowerCase();
      members = members.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q) ||
          m.department.toLowerCase().includes(q)
      );
    }

    res.status(200).json({
      success: true,
      total: members.length,
      data: members,
    });
  } catch (error) {
    next(error);
  }
};

export const addTeamMember = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { name, email, department, role, avatar } = req.body;

    const existing = await store.getUserByEmail(email);
    if (existing) {
      throw new AppError('User with this email already exists', 400);
    }

    const newMember: User = {
      id: `team-${Date.now()}`,
      name,
      email,
      department: department || 'Operations',
      role: (role as Role) || 'Editor',
      status: 'Active',
      avatar: avatar || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.createUser(newMember);

    res.status(201).json({
      success: true,
      message: 'Team member added successfully',
      data: {
        id: newMember.id,
        name: newMember.name,
        email: newMember.email,
        department: newMember.department,
        role: newMember.role,
        status: newMember.status,
        avatar: newMember.avatar,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const updateTeamMember = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const existing = await store.getUserById(id);
    if (!existing) {
      throw new AppError('Team member not found', 404);
    }

    const updated = await store.updateUser(id, updates);

    res.status(200).json({
      success: true,
      message: 'Team member updated successfully',
      data: {
        id: updated?.id,
        name: updated?.name,
        email: updated?.email,
        department: updated?.department,
        role: updated?.role,
        status: updated?.status,
        avatar: updated?.avatar,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const revokeTeamMember = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const success = await store.deleteUser(id);

    if (!success) {
      throw new AppError('Team member not found', 404);
    }

    res.status(200).json({
      success: true,
      message: 'Team member access revoked successfully',
    });
  } catch (error) {
    next(error);
  }
};

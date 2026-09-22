import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { randomBytes } from 'crypto';
import { createLogger } from '../utils/logger.js';
import { toAppError } from '../utils/error.util.js';
import { generateId, ok } from '../utils/response.util.js';

const log = createLogger('TeamController');

/* The UI shows "N / 10 Seats Used"; the limit belongs to the server, not the JSX. */
const SEAT_LIMIT = parseInt(process.env.TEAM_SEAT_LIMIT ?? '10', 10);
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
      throw new AppError('A user with this email already exists', 409);
    }

    /* Seats are a licensing constraint, so the server enforces them. */
    const roster = await store.getUsers();
    const used = roster.filter((u) => u.status !== 'Inactive').length;
    if (used >= SEAT_LIMIT) {
      throw new AppError(`All ${SEAT_LIMIT} seats are in use - free one before inviting`, 409);
    }

    const newMember: User = {
      id: generateId('team'),
      name,
      email: String(email).toLowerCase(),
      department: department || 'Operations',
      role: (role as Role) || 'Editor',
      /* Pending until the invitation is accepted. */
      status: 'Pending',
      avatar: avatar || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await store.createUser(newMember);

    /* Real delivery needs a mail transport. The token is issued and logged so
       the server side of the invite flow is complete once SMTP is wired in. */
    const inviteToken = randomBytes(24).toString('hex');
    log.log(`Invitation issued for ${newMember.email} (token ${inviteToken.slice(0, 8)})`);
    log.warn('No mail transport configured - the invitation was not delivered');

    res.status(201).json({
      success: true,
      message: 'Member created — invitation email not sent (no mail transport configured)',
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

export const getTeamStats = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const roster = await store.getUsers();
    const active = roster.filter((u) => u.status === 'Active').length;
    const pending = roster.filter((u) => u.status === 'Pending').length;
    const inactive = roster.filter((u) => u.status === 'Inactive').length;

    res.status(200).json(
      ok({
        active,
        pending,
        inactive,
        seatsUsed: active + pending,
        seatLimit: SEAT_LIMIT,
        /* No 2FA implementation exists, so this reports 0 rather than the
           decorative 100% the UI card asserts. */
        twoFactorCoverage: 0,
      })
    );
  } catch (error) {
    next(toAppError(error, 'Could not compute team statistics', log));
  }
};

/** Re-issues an invitation token for a member who never accepted. */
export const resendInvite = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const member = await store.getUserById(req.params.id);
    if (!member) throw new AppError('Team member not found', 404);

    const inviteToken = randomBytes(24).toString('hex');
    log.log(`Invitation re-issued for ${member.email} (token ${inviteToken.slice(0, 8)})`);
    log.warn('No mail transport configured - the invitation was not delivered');

    res.status(200).json(
      ok({ id: member.id, email: member.email, invitationSent: false }, 'Invitation re-issued')
    );
  } catch (error) {
    next(toAppError(error, `Could not resend the invitation for ${req.params.id}`, log));
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

    /* Deactivates rather than deleting, so audit history and authored records
       keep pointing at a real user. ?hard=true removes the row outright. */
    if (req.query.hard === 'true') {
      const success = await store.deleteUser(id);
      if (!success) throw new AppError('Team member not found', 404);
      log.warn(`Hard-deleted member ${id}`);
      res.status(200).json(ok({ id, deleted: true }, 'Team member deleted'));
      return;
    }

    const updated = await store.updateUser(id, {
      status: 'Inactive',
      updatedAt: new Date().toISOString(),
    });
    if (!updated) throw new AppError('Team member not found', 404);

    log.log(`Revoked access for member ${id}`);
    res.status(200).json(ok({ id, deleted: false, status: 'Inactive' }, 'Access revoked'));
  } catch (error) {
    next(error);
  }
};

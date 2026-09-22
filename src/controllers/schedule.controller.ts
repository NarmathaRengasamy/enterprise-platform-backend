import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
import { createLogger } from '../utils/logger.js';
import { toAppError } from '../utils/error.util.js';
import { ok } from '../utils/response.util.js';

const log = createLogger('ScheduleController');
import { ScheduleEvent } from '../types/index.js';

export const createEventSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'Title is required'),
    time: z.string().min(1, 'Time is required'),
    startTime: z.string().min(1, 'Start time is required'),
    endTime: z.string().min(1, 'End time is required'),
    dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be formatted as YYYY-MM-DD'),
    dayIndex: z.number().min(0).max(6).optional(),
    dateNum: z.number().optional(),
    topOffset: z.number().optional(),
    height: z.number().optional(),
    client: z.string().min(1, 'Client name is required'),
    email: z.string().optional(),
    phone: z.string().optional(),
    attendee: z.string().min(1, 'Attendee is required'),
    participantType: z.enum(['human', 'agent', 'customer']),
    type: z.string().min(1, 'Event type is required'),
    location: z.string().min(1, 'Location is required'),
    status: z.enum(['Confirmed', 'Pending', 'Cancelled', 'Completed']).optional().default('Confirmed'),
    statusColor: z.string().optional(),
    notes: z.string().optional(),
  }),
});

export const updateEventSchema = z.object({
  body: z.object({
    title: z.string().optional(),
    time: z.string().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    client: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    attendee: z.string().optional(),
    participantType: z.enum(['human', 'agent', 'customer']).optional(),
    type: z.string().optional(),
    location: z.string().optional(),
    status: z.enum(['Confirmed', 'Pending', 'Cancelled', 'Completed']).optional(),
    statusColor: z.string().optional(),
    notes: z.string().optional(),
  }),
});

export const getEvents = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { dateKey, dateFrom, dateTo, participantType, status } = req.query;
    const events = await store.getScheduleEvents({
      dateKey: dateKey as string,
      dateFrom: dateFrom as string,
      dateTo: dateTo as string,
      participantType: participantType as string,
      status: status as string,
    });

    res.status(200).json({
      success: true,
      total: events.length,
      data: events,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Accepts "09:00" and "09:00 AM"; both appear in the existing data.
 * Rejects an inverted range instead of silently coercing it to start+60min,
 * which is what the UI does today.
 */
const assertTimeRange = (start?: string, end?: string): void => {
  if (!start || !end) return;

  const toMinutes = (value: string): number | null => {
    const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
    if (!match) return null;
    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const meridiem = match[3]?.toUpperCase();
    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;
    return hours * 60 + minutes;
  };

  const from = toMinutes(start);
  const to = toMinutes(end);
  if (from === null || to === null) return;
  if (to <= from) throw new AppError('endTime must be later than startTime', 400);
};

/** Counts behind the All / Human / Agent / Customer filter tabs. */
export const getScheduleStats = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { dateFrom, dateTo } = req.query;
    const events = await store.getScheduleEvents({
      dateFrom: dateFrom as string,
      dateTo: dateTo as string,
    });

    res.status(200).json(
      ok({
        all: events.length,
        human: events.filter((e) => e.participantType === 'human').length,
        agent: events.filter((e) => e.participantType === 'agent').length,
        customer: events.filter((e) => e.participantType === 'customer').length,
      })
    );
  } catch (error) {
    next(toAppError(error, 'Could not compute schedule statistics', log));
  }
};

export const getEventById = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const event = await store.getScheduleEventById(id);

    if (!event) {
      throw new AppError('Event/Appointment not found', 404);
    }

    res.status(200).json({
      success: true,
      data: event,
    });
  } catch (error) {
    next(error);
  }
};

export const createEvent = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const body = req.body;
    assertTimeRange(body.startTime, body.endTime);
    const dateObj = new Date(body.dateKey);
    const dayIndex = body.dayIndex !== undefined ? body.dayIndex : (dateObj.getDay() + 6) % 7; // Monday = 0
    const dateNum = body.dateNum !== undefined ? body.dateNum : dateObj.getDate();

    const statusColorMap: Record<string, string> = {
      human: 'emerald',
      agent: 'purple',
      customer: 'emerald',
    };

    const newEvent: ScheduleEvent = {
      id: `ev-${Date.now()}`,
      dayIndex,
      dateNum,
      topOffset: body.topOffset || 640,
      height: body.height || 64,
      statusColor: body.statusColor || (body.status === 'Pending' ? 'amber' : statusColorMap[body.participantType] || 'emerald'),
      ...body,
    };

    const created = await store.createScheduleEvent(newEvent);

    res.status(201).json({
      success: true,
      message: 'Schedule event created successfully',
      data: created,
    });
  } catch (error) {
    next(error);
  }
};

export const updateEvent = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const existing = await store.getScheduleEventById(id);
    if (!existing) {
      throw new AppError('Event/Appointment not found', 404);
    }

    const updated = await store.updateScheduleEvent(id, updates);

    res.status(200).json({
      success: true,
      message: 'Event updated successfully',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

export const updateEventStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['Confirmed', 'Pending', 'Cancelled', 'Completed'].includes(status)) {
      throw new AppError('Invalid event status', 400);
    }

    const existing = await store.getScheduleEventById(id);
    if (!existing) {
      throw new AppError('Event not found', 404);
    }

    const statusColor = status === 'Cancelled' ? 'rose' : status === 'Pending' ? 'amber' : 'emerald';
    const updated = await store.updateScheduleEvent(id, { status, statusColor });

    res.status(200).json({
      success: true,
      message: `Event marked as ${status}`,
      data: updated,
    });
  } catch (error) {
    next(error);
  }
};

export const deleteEvent = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const success = await store.deleteScheduleEvent(id);

    if (!success) {
      throw new AppError('Event not found', 404);
    }

    res.status(200).json({
      success: true,
      message: 'Event deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

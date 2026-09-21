import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { store } from '../data/store.js';
import { AppError } from '../middlewares/errorHandler.js';
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
    const { dateKey, participantType, status } = req.query;
    const events = await store.getScheduleEvents({
      dateKey: dateKey as string,
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

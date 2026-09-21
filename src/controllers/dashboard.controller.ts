import { Request, Response, NextFunction } from 'express';
import { store } from '../data/store.js';

export const getDashboardMetrics = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const metrics = await store.getDashboardMetrics();
    res.status(200).json({
      success: true,
      data: metrics,
    });
  } catch (error) {
    next(error);
  }
};

export const getDashboardOverview = async (
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const [metrics, products, appointments, conversations] = await Promise.all([
      store.getDashboardMetrics(),
      store.getProducts(),
      store.getScheduleEvents(),
      store.getConversations(),
    ]);

    res.status(200).json({
      success: true,
      data: {
        metrics,
        recentProducts: products.slice(0, 4),
        recentAppointments: appointments.slice(0, 3),
        recentConversations: conversations.slice(0, 3),
      },
    });
  } catch (error) {
    next(error);
  }
};

import { Request, Response, NextFunction } from 'express';
import { store } from '../data/store.js';
import { isDbConnected } from '../config/db.js';
import { productSearchService } from '../services/productSearch.service.js';

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

    let recentProducts: any[] = products.slice(0, 4);
    if (isDbConnected()) {
      try {
        const v2Search = await productSearchService.search({ page: 1, limit: 4, sort: 'newest' }, { viewer: false });
        if (v2Search && v2Search.items?.length > 0) {
          recentProducts = v2Search.items;
        }
      } catch {
        /* Fall back to v1 */
      }
    }

    res.status(200).json({
      success: true,
      data: {
        metrics,
        recentProducts,
        recentAppointments: appointments.slice(0, 3),
        recentConversations: conversations.slice(0, 3),
      },
    });
  } catch (error) {
    next(error);
  }
};


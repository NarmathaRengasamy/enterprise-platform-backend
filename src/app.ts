import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config/index.js';
import { errorHandler } from './middlewares/errorHandler.js';

// Route imports
import authRoutes from './routes/auth.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import productRoutes from './routes/product.routes.js';
import categoryRoutes from './routes/category.routes.js';
import conversationRoutes from './routes/conversation.routes.js';
import scheduleRoutes from './routes/schedule.routes.js';
import knowledgeRoutes from './routes/knowledge.routes.js';
import teamRoutes from './routes/team.routes.js';
import developerRoutes from './routes/developer.routes.js';

export const createApp = (): Express => {
  const app = express();

  // Security headers
  app.use(helmet());

  // CORS configuration
  app.use(
    cors({
      origin: (origin, callback) => {
        // allow requests with no origin (like mobile apps, curl, Postman)
        if (!origin) return callback(null, true);
        if (config.corsOrigins.includes(origin) || config.corsOrigins.includes('*')) {
          return callback(null, true);
        }
        return callback(null, true); // Permissive in dev mode
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Perfox-API-Key', 'X-API-Key'],
    })
  );

  // Request body parsers
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // HTTP request logging
  if (config.nodeEnv !== 'test') {
    app.use(morgan('dev'));
  }

  // Health check endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'healthy',
      service: 'enterprise-platform-backend',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // API V1 Routes
  const apiRouter = express.Router();
  apiRouter.use('/auth', authRoutes);
  apiRouter.use('/dashboard', dashboardRoutes);
  apiRouter.use('/products', productRoutes);
  apiRouter.use('/categories', categoryRoutes);
  apiRouter.use('/conversations', conversationRoutes);
  apiRouter.use('/schedule', scheduleRoutes);
  apiRouter.use('/knowledge', knowledgeRoutes);
  apiRouter.use('/team', teamRoutes);
  apiRouter.use('/developer', developerRoutes);

  app.use('/api/v1', apiRouter);

  // Root welcome
  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      name: 'Perfox / OmniFlow Enterprise Platform API',
      status: 'running',
      version: '1.0.0',
      documentation: '/api/v1/...',
      endpoints: {
        health: '/api/health',
        auth: '/api/v1/auth',
        dashboard: '/api/v1/dashboard',
        products: '/api/v1/products',
        categories: '/api/v1/categories',
        conversations: '/api/v1/conversations',
        schedule: '/api/v1/schedule',
        knowledge: '/api/v1/knowledge',
        team: '/api/v1/team',
        developer: '/api/v1/developer',
      },
    });
  });

  // 404 Route Catch-all
  app.use('*', (req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      message: `Route ${req.originalUrl} not found on this server`,
    });
  });

  // Central Error Handler Middleware
  app.use(errorHandler);

  return app;
};

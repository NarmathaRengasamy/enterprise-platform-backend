import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config/index.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { authenticateJWT } from './middlewares/auth.js';
import { requestLogger } from './middlewares/requestLogger.js';
import { isDbConnected } from './config/db.js';
import swaggerUi from 'swagger-ui-express';
import { openApiDocument } from './docs/openapi.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('App');

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
import operatorRoutes from './routes/operator.routes.js';
import mcpRoutes from './routes/mcp.routes.js';
import publicRoutes from './routes/public.routes.js';

export const createApp = (): Express => {
  const app = express();

  // Security headers
  /* Swagger UI serves inline styles and scripts, which helmet's default CSP
     blocks outright — the page renders blank. The rest of helmet still applies. */
  app.use(helmet({ contentSecurityPolicy: false }));

  // CORS configuration
  app.use(
    cors({
      origin: (origin, callback) => {
        // No Origin header: curl, Postman, server-to-server.
        if (!origin) return callback(null, true);
        if (config.corsOrigins.includes(origin) || config.corsOrigins.includes('*')) {
          return callback(null, true);
        }
        /* The old code fell through to `callback(null, true)` for EVERY origin,
           which made the allowlist decorative. */
        log.warn(`Blocked a cross-origin request from ${origin}`);
        return callback(new Error('Not allowed by CORS'), false);
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
    app.use(requestLogger);
  }

  // Health check endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    /* Reports the database too — a probe that only proves the process is alive
       will happily keep a broken instance in rotation. */
    const dbUp = isDbConnected();
    res.status(200).json({
      status: dbUp ? 'healthy' : 'degraded',
      service: 'enterprise-platform-backend',
      version: '1.0.0',
      database: dbUp ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  /* API documentation.
     Mounted outside /api/v1 so it is reachable without a token — you need the
     docs in order to work out how to get one. Disable with ENABLE_DOCS=false;
     it defaults off in production, where publishing the full surface (and the
     Try-it button) is rarely what you want. */
  const docsEnabled =
    (process.env.ENABLE_DOCS ?? (config.nodeEnv === 'production' ? 'false' : 'true')).toLowerCase() !==
    'false';

  if (docsEnabled) {
    app.get('/api/docs.json', (_req: Request, res: Response) => res.json(openApiDocument));
    app.use(
      '/api/docs',
      swaggerUi.serve,
      swaggerUi.setup(openApiDocument, {
        customSiteTitle: 'Perfox Enterprise Platform API',
        swaggerOptions: { persistAuthorization: true, docExpansion: 'none', filter: true },
      })
    );
    log.log('API documentation served at /api/docs');
  }

  // API V1 Routes
  const apiRouter = express.Router();

  /* Auth routes stay public (login, register); everything mounted after the
     guard below requires a bearer token. Previously only GET /auth/me was
     protected and every mutation in the app was open to anyone. */
  apiRouter.use('/auth', authRoutes);
  apiRouter.use(authenticateJWT);
  apiRouter.use('/dashboard', dashboardRoutes);
  apiRouter.use('/products', productRoutes);
  apiRouter.use('/categories', categoryRoutes);
  apiRouter.use('/conversations', conversationRoutes);
  apiRouter.use('/schedule', scheduleRoutes);
  apiRouter.use('/knowledge', knowledgeRoutes);
  apiRouter.use('/team', teamRoutes);
  apiRouter.use('/developer', developerRoutes);
  apiRouter.use('/operator', operatorRoutes);

  app.use('/api/v1', apiRouter);

  /* MCP sits OUTSIDE the API router on purpose: its caller is an AI agent on
     the Perfox platform, not a signed-in member of staff, so it carries a
     shared secret rather than a user JWT. */
  app.use('/mcp', mcpRoutes);

  /* The public catalogue: unauthenticated, read-only, rate limited. Outside the
     API router for the same reason as MCP — its caller is a shopper on a
     website, not a member of staff with a session. */
  app.use('/public', publicRoutes);

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

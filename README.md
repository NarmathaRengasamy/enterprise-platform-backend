# Perfox / OmniFlow Enterprise Platform Backend

Production-ready Node.js + TypeScript backend service for the Perfox / OmniFlow Enterprise Platform.

## 🚀 Features

- **TypeScript Architecture**: Strict typing, ES Modules (`NodeNext`), and clean modular layer separation.
- **RESTful API**: Full endpoints corresponding to all frontend modules.
- **Authentication & Security**: JWT-based session handling, password hashing, Helmet headers, CORS configuration.
- **Validation**: Schema-based validation using Zod.
- **Data Store**: Stateful in-memory repository initialized with realistic enterprise seed data (products, multi-channel conversations, calendar events, developer bots, webhook endpoints, articles, and team members).
- **Extensible Architecture**: Ready for easy migration to databases like PostgreSQL / MongoDB / Prisma.

---

## 📁 Directory Structure

```
enterprise-platform-backend/
├── src/
│   ├── config/             # Environment variables & constants
│   ├── controllers/        # Request handlers & logic
│   │   ├── auth.controller.ts
│   │   ├── category.controller.ts
│   │   ├── conversation.controller.ts
│   │   ├── dashboard.controller.ts
│   │   ├── developer.controller.ts
│   │   ├── knowledge.controller.ts
│   │   ├── product.controller.ts
│   │   ├── schedule.controller.ts
│   │   └── team.controller.ts
│   ├── data/               # Seed data & in-memory data store
│   │   ├── seedData.ts
│   │   └── store.ts
│   ├── middlewares/        # Express middlewares (auth, validation, error handler)
│   │   ├── auth.ts
│   │   ├── errorHandler.ts
│   │   └── validate.ts
│   ├── routes/             # Express route declarations
│   │   ├── auth.routes.ts
│   │   ├── category.routes.ts
│   │   ├── conversation.routes.ts
│   │   ├── dashboard.routes.ts
│   │   ├── developer.routes.ts
│   │   ├── knowledge.routes.ts
│   │   ├── product.routes.ts
│   │   ├── schedule.routes.ts
│   │   └── team.routes.ts
│   ├── types/              # Domain interfaces & TypeScript types
│   │   └── index.ts
│   ├── app.ts              # Express application configuration
│   └── server.ts           # Server bootstrap & lifecycle management
├── .env.example
├── .env
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🛠️ Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Create a `.env` file (copied from `.env.example`):
```bash
PORT=5000
NODE_ENV=development
JWT_SECRET=super_secret_perfox_enterprise_jwt_key_2026_!#
JWT_EXPIRES_IN=7d
CORS_ORIGIN=http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173
```

### 3. Run Development Server
```bash
npm run dev
```

### 4. Build for Production
```bash
npm run build
npm start
```

---

## 📡 API Endpoints Reference

### 1. Health Check
- `GET /api/health` - Check backend service uptime and status.

### 2. Authentication & Profile
- `POST /api/v1/auth/login` - Authenticate with email and password (`sarah@omniflow.io` / `password123`).
- `POST /api/v1/auth/register` - Register a new user.
- `GET /api/v1/auth/me` - Get current authenticated user profile (Bearer token required).

### 3. Dashboard
- `GET /api/v1/dashboard/metrics` - High-level metrics (total products, active conversations, bookings, agent calls).
- `GET /api/v1/dashboard/overview` - Complete dashboard feed (metrics + recent products, appointments, conversations).

### 4. Products & Catalog
- `GET /api/v1/products` - List products with optional query params (`?category=...&status=...&search=...&page=1&limit=50`).
- `GET /api/v1/products/:id` - Get product details by ID or SKU.
- `POST /api/v1/products` - Create a new product.
- `PUT /api/v1/products/:id` - Update existing product.
- `DELETE /api/v1/products/:id` - Delete product.

### 5. Categories
- `GET /api/v1/categories` - List categories (supports `?search=...`).
- `GET /api/v1/categories/:id` - Get category by ID.
- `POST /api/v1/categories` - Create new category.
- `PUT /api/v1/categories/:id` - Update category.
- `DELETE /api/v1/categories/:id` - Delete category.
- `GET /api/v1/categories/export` - Export categories as JSON file.

### 6. Conversations & Messaging
- `GET /api/v1/conversations` - List conversations (supports `?channel=...&search=...`).
- `GET /api/v1/conversations/:id` - Get conversation thread with all message history.
- `POST /api/v1/conversations` - Create a new conversation thread.
- `POST /api/v1/conversations/:id/messages` - Send a message to a conversation thread.
- `PATCH /api/v1/conversations/:id/read` - Mark conversation as read.

### 7. Schedule & Calendar
- `GET /api/v1/schedule` - List schedule events (supports `?dateKey=YYYY-MM-DD&participantType=...&status=...`).
- `GET /api/v1/schedule/:id` - Get event details.
- `POST /api/v1/schedule` - Create appointment / calendar event.
- `PUT /api/v1/schedule/:id` - Update event.
- `PATCH /api/v1/schedule/:id/status` - Update event status (`Confirmed`, `Pending`, `Cancelled`, `Completed`).
- `DELETE /api/v1/schedule/:id` - Delete event.

### 8. Knowledge Base
- `GET /api/v1/knowledge/articles` - List articles (supports `?category=...&search=...`).
- `GET /api/v1/knowledge/articles/:id` - Get article by ID.
- `POST /api/v1/knowledge/articles` - Create knowledge article.
- `PUT /api/v1/knowledge/articles/:id` - Update article.
- `DELETE /api/v1/knowledge/articles/:id` - Delete article.
- `GET /api/v1/knowledge/collections` - List knowledge collections.
- `POST /api/v1/knowledge/collections` - Create collection.
- `POST /api/v1/knowledge/sync` - Generate auto-synced catalog markdown for LLM retrieval.

### 9. Team Management
- `GET /api/v1/team/members` - List team members (supports `?role=...&status=...&search=...`).
- `POST /api/v1/team/members` - Invite/Add new team member.
- `PUT /api/v1/team/members/:id` - Update member role / department / status.
- `DELETE /api/v1/team/members/:id` - Revoke member access.

### 10. Developer & AI Gateway
- `GET /api/v1/developer/agents` - List AI Agents.
- `GET /api/v1/developer/agents/:id` - Get AI Agent details.
- `POST /api/v1/developer/agents` - Create AI Agent with auto-generated site and secret keys.
- `PUT /api/v1/developer/agents/:id` - Update AI Agent configuration.
- `DELETE /api/v1/developer/agents/:id` - Delete AI Agent.
- `GET /api/v1/developer/endpoints` - List Webhook Endpoints.
- `POST /api/v1/developer/endpoints` - Register Webhook Endpoint.
- `PUT /api/v1/developer/endpoints/:id` - Update Webhook Endpoint.
- `DELETE /api/v1/developer/endpoints/:id` - Delete Webhook Endpoint.
- `POST /api/v1/developer/endpoints/:id/ping` - Test & ping endpoint for health & latency check.

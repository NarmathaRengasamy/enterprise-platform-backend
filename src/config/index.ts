import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '5050', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/enterprise_platform',
  jwtSecret: process.env.JWT_SECRET || 'super_secret_perfox_enterprise_jwt_key_2026_!#',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim()),
  perfoxApiUrl: process.env.PERFOX_API_URL || 'https://<your-workspace>.perfox.ai/api/v1',
  perfoxApiToken:
    process.env.PERFOX_API_TOKEN ||
    'Bearer sk_....',
};

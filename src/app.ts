import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './utils/logger';
import { config } from './config';
import customerRoutes from './routes/customer.routes';
import transactionRoutes from './routes/transaction.routes';
import authRoutes from './routes/auth.routes';
import { generalApiRateLimiter } from './middleware/rateLimiter';

const app = express();

// Trust reverse proxy (e.g. Render, Cloudflare) for accurate client IP in rate limiting & headers
app.set('trust proxy', 1);

// Security & Performance Middleware
app.use(helmet());
app.use(compression());

// Environment-controlled CORS configuration
if (config.CORS_ALLOWED_ORIGINS === '*') {
  app.use(cors({ origin: '*' }));
} else {
  const allowedOrigins = config.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim());
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (e.g. mobile apps, curl, server-to-server, health probes)
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`CORS Error: Origin ${origin} not allowed`));
        }
      },
    }),
  );
}

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Request logging middleware
const morganFormat = config.NODE_ENV === 'development' ? 'dev' : 'combined';
app.use(
  morgan(morganFormat, {
    stream: {
      write: (message) => logger.http(message.trim()),
    },
  }),
);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Server is healthy',
    timestamp: new Date().toISOString(),
  });
});

// General API rate limiter for /api/v1 routes
app.use('/api/v1', generalApiRateLimiter);

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/transactions', transactionRoutes);

// Centralized error handling middleware
app.use(errorHandler);

export default app;

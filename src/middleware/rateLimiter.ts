import rateLimit from 'express-rate-limit';
import { config } from '../config';
import { Request, Response } from 'express';

/**
 * Rate limiter middleware for authentication routes (e.g. POST /api/v1/auth/login)
 * Protects against brute-force credential stuffing and DoS attacks.
 */
export const loginRateLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX_LOGIN_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  // Allow disabling or bypassing in automated unit test environment when needed
  skip: () => config.NODE_ENV === 'test',
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      status: 'error',
      message: 'Too many login attempts. Please try again later.',
    });
  },
});

/**
 * General API rate limiter middleware for /api/v1 routes.
 * Protects against Denial-of-Service (DoS), resource exhaustion, and high-volume API abuse.
 */
export const generalApiRateLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  limit: config.RATE_LIMIT_MAX_GENERAL_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test',
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      status: 'error',
      message: 'Too many requests from this IP. Please try again later.',
    });
  },
});

/**
 * Factory for creating isolated rate limiter instances (e.g. for dedicated tests).
 */
export const createCustomRateLimiter = (options: {
  windowMs: number;
  limit: number;
  message: string;
  skip?: () => boolean;
}) =>
  rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: options.skip || (() => false),
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        status: 'error',
        message: options.message,
      });
    },
  });

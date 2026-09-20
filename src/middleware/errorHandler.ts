import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): Response => {
  if (err instanceof AppError) {
    logger.warn(`Operational error: ${err.message} (Status: ${err.statusCode})`);
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
    });
  }

  if (err instanceof z.ZodError) {
    logger.warn(`Validation error: ${JSON.stringify(err.issues)}`);
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: err.issues.map((e: z.ZodIssue) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
  }

  // Handle malformed JSON body errors from express.json()
  if (
    err instanceof SyntaxError &&
    'status' in err &&
    (err as { status: number }).status === 400 &&
    'body' in err
  ) {
    logger.warn(`Malformed JSON payload in request: ${err.message}`);
    return res.status(400).json({
      status: 'error',
      message: 'Malformed JSON payload in request body',
    });
  }

  // Unhandled/Programming error: log stack trace and send generic response
  const fullError = {
    name: err.name,
    code: (err as { code?: string }).code,
    message: err.message,
    meta: (err as { meta?: unknown }).meta,
    clientVersion: (err as { clientVersion?: string }).clientVersion,
    stack: err.stack,
  };
  logger.error(`Unhandled error:\n${JSON.stringify(fullError, null, 2)}`);
  return res.status(500).json({
    status: 'error',
    message: 'Something went wrong on the server',
  });
};

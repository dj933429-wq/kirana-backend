import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../config/database';
import { AppError } from './errorHandler';

interface JwtPayload {
  id: string;
  email: string;
}

export const authMiddleware = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('Unauthorized: Token missing or malformed', 401);
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      throw new AppError('Unauthorized: Token missing', 401);
    }

    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(token, config.JWT_SECRET, {
        algorithms: ['HS256'],
      }) as JwtPayload;
    } catch {
      throw new AppError('Unauthorized: Invalid or expired token', 401);
    }

    // Verify merchant still exists in the database
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
    });

    if (!user) {
      throw new AppError('Unauthorized: User no longer exists', 401);
    }

    // Attach verified database record to req.user
    req.user = {
      id: user.id,
      email: user.email,
      businessName: user.businessName,
    };

    next();
  } catch (err) {
    next(err);
  }
};

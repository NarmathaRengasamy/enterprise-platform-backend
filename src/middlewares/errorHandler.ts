import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;
  /**
   * The upstream error body, when there was one.
   *
   * Perfox puts the actionable part of a refusal in the payload rather than the
   * status — a folder delete answers 409 with the file and subfolder counts —
   * so it is carried here for a handler that knows what to do with it. It is
   * never serialised to the client directly.
   */
  public details?: any;
  /**
   * Per-field failures for a business-rule refusal (usually a 422), keyed by the
   * field as the client knows it (`sku`, `items.2.price`). Serialised as the same
   * `errors: [{ path, message }]` array a Zod failure produces, so a form marks
   * the offending inputs either way.
   */
  public fieldErrors?: Record<string, string>;

  constructor(
    message: string,
    statusCode: number = 500,
    details?: any,
    fieldErrors?: Record<string, string>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.details = details;
    this.fieldErrors = fieldErrors;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const formattedErrors = err.errors.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    }));

    res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: formattedErrors,
    });
    return;
  }

  // Handle custom AppError
  if (err instanceof AppError) {
    const errors = err.fieldErrors
      ? Object.entries(err.fieldErrors).map(([path, message]) => ({ path, message }))
      : undefined;
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      ...(errors?.length ? { errors } : {}),
    });
    return;
  }

  // Handle unexpected errors
  console.error('Unhandled Server Error:', err);
  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message || 'Internal server error',
  });
};

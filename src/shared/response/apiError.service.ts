export class ApiError extends Error {
  public readonly status: 'fail' | 'error';
  public readonly isOperational: boolean;

  constructor(
    public readonly statusCode: number,
    message: string,
    isOperational = true,
  ) {
    super(message);

    this.name = this.constructor.name;
    this.status = statusCode >= 400 && statusCode < 500 ? 'fail' : 'error';
    this.isOperational = isOperational;

    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = 'Bad Request') {
    return new ApiError(400, message);
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message);
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError(403, message);
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, message);
  }

  static conflict(message = 'Conflict') {
    return new ApiError(409, message);
  }

  static invalidToken(message = 'Invalid Token') {
    return new ApiError(498, message);
  }

  static internalServerError(message = 'Internal Server Error') {
    return new ApiError(500, message, false);
  }
}

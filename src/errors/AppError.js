// ═══════════════════════════════════════════════════
// Error Taxonomy — AppError
// All thrown errors should use this class so the
// global handler can distinguish 4xx from 5xx and
// log / respond correctly.
// ═══════════════════════════════════════════════════

class AppError extends Error {
    /**
     * @param {string}  message      - Human-readable message (safe to surface to client)
     * @param {number}  statusCode   - HTTP status code (400, 429, 500, …)
     * @param {string}  [code]       - Machine-readable code  e.g. 'RATE_LIMITED'
     * @param {boolean} [isOperational=true]
     *   true  → expected / predictable error (bad input, rate-limit, upstream 429)
     *   false → programmer error / unexpected crash → should alert & restart
     */
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', isOperational = true) {
        super(message);
        this.name        = 'AppError';
        this.statusCode  = statusCode;
        this.code        = code;
        this.isOperational = isOperational;
        Error.captureStackTrace(this, this.constructor);
    }
}

// ── Convenience factories ─────────────────────────

/** 400 Bad Request */
AppError.badRequest = (message, code = 'BAD_REQUEST') =>
    new AppError(message, 400, code);

/** 408 Request Timeout */
AppError.timeout = (message = 'Request timed out. Please try again.') =>
    new AppError(message, 408, 'TIMEOUT');

/** 413 Payload Too Large */
AppError.payloadTooLarge = (message = 'File too large.') =>
    new AppError(message, 413, 'PAYLOAD_TOO_LARGE');

/** 422 Unprocessable Entity — Zod validation failure */
AppError.validation = (message, issues = []) => {
    const err = new AppError(message, 422, 'VALIDATION_ERROR');
    err.issues = issues;
    return err;
};

/** 429 Too Many Requests */
AppError.rateLimited = (message = 'Too many requests. Wait a minute.') =>
    new AppError(message, 429, 'RATE_LIMITED');

/** 502 Bad Gateway — upstream API failure */
AppError.upstream = (message = 'Upstream service unavailable.', code = 'UPSTREAM_ERROR') =>
    new AppError(message, 502, code);

/** 500 Internal — programmer / unexpected error */
AppError.internal = (message = 'Internal server error.') =>
    new AppError(message, 500, 'INTERNAL_ERROR', false);

module.exports = AppError;
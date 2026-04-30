// ═══════════════════════════════════════════════════
// Validation Schemas — Zod
// Central place for ALL request-body validation.
// Each schema exported here maps to one route.
// ═══════════════════════════════════════════════════
const { z } = require('zod');
const AppError = require('../errors/AppError');

// ── Reusable base types ───────────────────────────

/** Non-empty string, trimmed, max 2000 chars, no control chars */
const safeString = (max = 2000) =>
    z.string()
     .trim()
     .min(1, 'Field is required')
     .max(max, `Must be at most ${max} characters`)
     .transform(s => s.replace(/[\x00-\x1F\x7F]/g, ' ').replace(/\s+/g, ' ').trim());

/** Valid game identifier */
const gameEnum = z.enum(['coc', 'cr', 'bs', 'wao', 'general']).default('general');

// ── Route schemas ─────────────────────────────────

/**
 * POST /chat
 * { userQuery: string }
 */
const chatSchema = z.object({
    userQuery: safeString(2000)
});

/**
 * POST /analyze-image  (multipart — body fields only, file handled by multer)
 * { query?: string, game?: gameEnum }
 */
const analyzeImageSchema = z.object({
    query: safeString(500).optional().default(''),
    game:  gameEnum
});

// ── Validation middleware factory ─────────────────

/**
 * Returns an Express middleware that validates `req.body`
 * against the given Zod schema.
 * On failure it throws an AppError.validation so the
 * global error handler can respond consistently.
 *
 * @param {z.ZodSchema} schema
 */
function validate(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const issues = result.error.issues.map(i => ({
                field:   i.path.join('.'),
                message: i.message
            }));
            return next(AppError.validation(
                `Validation failed: ${issues.map(i => `${i.field} — ${i.message}`).join('; ')}`,
                issues
            ));
        }
        // Replace req.body with the parsed+transformed value
        req.body = result.data;
        next();
    };
}

module.exports = { chatSchema, analyzeImageSchema, validate };
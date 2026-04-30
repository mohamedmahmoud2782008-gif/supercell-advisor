// ═══════════════════════════════════════════════════
// Circuit Breaker — wraps external API calls
//
// Uses `opossum` to prevent cascading failures when
// Groq / Gemini / Tavily are unavailable.
//
// States:
//   CLOSED  → normal operation, requests pass through
//   OPEN    → API is down, fail-fast with fallback
//   HALF    → testing recovery, one probe request
//
// Install: npm install opossum
// ═══════════════════════════════════════════════════
const CircuitBreaker = require('opossum');

/**
 * Default options — tune per service if needed.
 * @see https://nodeshift.dev/opossum/
 */
const DEFAULTS = {
    timeout:              parseInt(process.env.CB_TIMEOUT_MS,           10) || 65_000, // ms before a single call times out
    errorThresholdPercentage: parseInt(process.env.CB_ERROR_THRESHOLD,  10) || 50,    // % failures to open circuit
    resetTimeout:         parseInt(process.env.CB_RESET_TIMEOUT_MS,     10) || 30_000, // ms before trying half-open
    volumeThreshold:      parseInt(process.env.CB_VOLUME_THRESHOLD,     10) || 4,     // min requests before tripping
    rollingCountTimeout:  parseInt(process.env.CB_ROLLING_WINDOW_MS,    10) || 10_000
};

/**
 * Factory — creates a named circuit breaker for an async function.
 *
 * @param {Function} asyncFn       - The async function to protect (e.g. callGroq)
 * @param {string}   name          - Human label used in logs / metrics
 * @param {object}   [overrides]   - Per-breaker option overrides
 * @returns {CircuitBreaker}
 */
function createBreaker(asyncFn, name, overrides = {}) {
    const options = { ...DEFAULTS, ...overrides, name };
    const breaker = new CircuitBreaker(asyncFn, options);

    // ── Logging hooks ─────────────────────────────
    breaker.on('open',     () => console.error(`[CircuitBreaker] ⛔ ${name} OPEN  — failing fast`));
    breaker.on('halfOpen', () => console.warn( `[CircuitBreaker] 🔶 ${name} HALF-OPEN — probing`));
    breaker.on('close',    () => console.log(  `[CircuitBreaker] ✅ ${name} CLOSED — recovered`));
    breaker.on('fallback', (result) => console.warn(`[CircuitBreaker] 🔁 ${name} fallback fired`));
    breaker.on('timeout',  () => console.warn(`[CircuitBreaker] ⏱ ${name} timed out`));
    breaker.on('reject',   () => console.warn(`[CircuitBreaker] 🚫 ${name} rejected (OPEN)`));

    return breaker;
}

module.exports = { createBreaker };
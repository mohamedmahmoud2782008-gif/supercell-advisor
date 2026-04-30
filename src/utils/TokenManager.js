// ═══════════════════════════════════════════════════
// TokenManager — Thread-safe API Key Round-Robin
//
// Node.js is single-threaded, but concurrent async
// operations can interleave, causing a shared mutable
// counter like `groqIdx++` to skip or repeat keys.
// TokenManager encapsulates state and exposes an
// atomic `next()` method.
// ═══════════════════════════════════════════════════

class TokenManager {
    /**
     * @param {string[]} keys   - Array of API key strings
     * @param {string}   label  - Label for logging (e.g. 'Groq', 'Google')
     */
    constructor(keys, label = 'API') {
        if (!keys || keys.length === 0)
            throw new Error(`TokenManager [${label}]: no keys provided`);

        this._keys  = [...keys]; // defensive copy
        this._idx   = 0;
        this._label = label;
    }

    /**
     * Returns the next key in round-robin order.
     * Safe for concurrent async callers in Node.js
     * because the increment + modulo is synchronous
     * (no await between read and write).
     * @returns {string}
     */
    next() {
        const key = this._keys[this._idx % this._keys.length];
        this._idx = (this._idx + 1) % this._keys.length; // wrap to avoid int overflow
        return key;
    }

    /** How many keys are available */
    get size() { return this._keys.length; }

    /** Label for logging */
    get label() { return this._label; }
}

module.exports = TokenManager;
// ═══════════════════════════════════════════════════
// Search Cache — In-Memory with TTL
// ═══════════════════════════════════════════════════

const TTL_MS      = parseInt(process.env.CACHE_TTL_MS, 10) || 60 * 60 * 1000; // ساعة
const MAX_ENTRIES = parseInt(process.env.CACHE_MAX,    10) || 200;             // أقصى عدد مدخلات

class searchCache {
    constructor() {
        this._store = new Map();
    }

    /** مفتاح موحد من السؤال والـ game */
    _key(query, game) {
        return `${game}::${query.toLowerCase().trim()}`;
    }

    /**
     * بيرجع النتيجة المحفوظة لو موجودة وطازجة.
     */
    get(query, game) {
        const key    = this._key(query, game);
        const entry  = this._store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this._store.delete(key);
            return null;
        }
        console.log(`[Cache] HIT — game=${game} query="${query.slice(0, 50)}"`);
        return entry.value;
    }

    /**
     * بيحفظ نتيجة البحث.
     */
    set(query, game, value) {
        if (!value) return; 

        if (this._store.size >= MAX_ENTRIES) {
            const oldestKey = this._store.keys().next().value;
            this._store.delete(oldestKey);
        }

        const key = this._key(query, game);
        this._store.set(key, {
            value,
            expiresAt: Date.now() + TTL_MS
        });
        console.log(`[Cache] SET — game=${game} query="${query.slice(0, 50)}" TTL=${TTL_MS / 60000}min`);
    }

    stats() {
        const now   = Date.now();
        const valid = [...this._store.values()].filter(e => now <= e.expiresAt).length;
        return { total: this._store.size, valid, maxEntries: MAX_ENTRIES, ttlMinutes: TTL_MS / 60000 };
    }

    clear() {
        this._store.clear();
        console.log('[Cache] Cleared');
    }
}

// Singleton — instance واحدة على طول عمر السيرفر
module.exports = new SearchCache();
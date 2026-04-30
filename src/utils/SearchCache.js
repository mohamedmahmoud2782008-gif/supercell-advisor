// ═══════════════════════════════════════════════════
// Search Cache — In-Memory with TTL
//
// منع نفس السؤال يعمل Tavily request أكتر من مرة.
// TTL افتراضي ساعة واحدة — قابل للتغيير من env.
// ═══════════════════════════════════════════════════

const TTL_MS      = parseInt(process.env.CACHE_TTL_MS, 10) || 60 * 60 * 1000; // ساعة
const MAX_ENTRIES = parseInt(process.env.CACHE_MAX,    10) || 200;             // أقصى عدد مدخلات

class SearchCache {
    constructor() {
        this._store = new Map();
    }

    /** مفتاح موحد من السؤال والـ game */
    _key(query, game) {
        return `${game}::${query.toLowerCase().trim()}`;
    }

    /**
     * بيرجع النتيجة المحفوظة لو موجودة وطازجة.
     * @returns {string|null}
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
     * لو المخزن وصل الحد الأقصى، بيمسح أقدم مدخل.
     */
    set(query, game, value) {
        if (!value) return; // مش بنحفظ نتائج فاضية

        // لو وصلنا الحد، امسح أقدم مدخل (FIFO)
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

    /** إحصائيات للـ /health endpoint */
    stats() {
        const now   = Date.now();
        const valid = [...this._store.values()].filter(e => now <= e.expiresAt).length;
        return { total: this._store.size, valid, maxEntries: MAX_ENTRIES, ttlMinutes: TTL_MS / 60000 };
    }

    /** مسح كل المخزن — للاختبار أو الـ admin */
    clear() {
        this._store.clear();
        console.log('[Cache] Cleared');
    }
}

// Singleton — instance واحدة على طول عمر السيرفر
module.exports = new SearchCache();
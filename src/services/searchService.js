// ═══════════════════════════════════════════════════
// Web Search Service — Tavily + Cache
// ═══════════════════════════════════════════════════
const axios       = require('axios');
const { extractSearchKeywords } = require('./gameDetector');
const searchCache = require('../utils/searchCache');

const TAVILY_KEY = process.env.TAVILY_API_KEY;

const EXCLUDED_DOMAINS = [
    'youtube.com','instagram.com','facebook.com','tiktok.com','x.com','twitter.com',
    'blizzard.com','wowhead.com','icy-veins.com','iiss.org',
    'visionofhumanity.org','globalterrorismindex.org','worldofwarcraft.com'
];

const TRUSTED_DOMAINS = {
    coc:     ['clash.ninja','clashofstats.com','clashtrack.com','clashofclans.com',
              'clashofclans.fandom.com','clashchampions.tv'],
    cr:      ['royaleapi.com','statsroyale.com','royalefire.com','clashroyale.com',
              'clashroyale.fandom.com'],
    bs:      ['brawltime.ninja','brawlify.com','brawlstars.com','brawlstars.fandom.com'],
    wao:     ['war-and-order.fandom.com','waoguide.com','lordsgameguide.com',
              'ldshop.gg','waroforder.com'],
    general: ['clash.ninja','royaleapi.com','brawltime.ninja','war-and-order.fandom.com']
};

const GAME_PREFIX = {
    coc: 'Clash of Clans', cr: 'Clash Royale',
    bs:  'Brawl Stars',    wao: 'War and Order', general: 'Supercell'
};
const GAME_TAG = {
    coc: 'strategy meta attack', cr: 'deck meta win rate',
    bs:  'brawler meta tier',    wao: 'strategy guide troops', general: 'strategy guide'
};

function isTrustedSource(url, game) {
    return (TRUSTED_DOMAINS[game] || TRUSTED_DOMAINS.general).some(d => url.includes(d));
}

function createTimer(label) {
    const start = Date.now();
    return { end: () => console.log(`[⏱ ${label}] ${Date.now() - start}ms`) };
}

async function doSearch(query, depth = 'advanced') {
    const timeout = parseInt(process.env.TAVILY_TIMEOUT_MS, 10) || 10_000;
    try {
        const r = await axios.post('https://api.tavily.com/search', {
            api_key: TAVILY_KEY, query,
            search_depth: depth, max_results: 5,
            exclude_domains: EXCLUDED_DOMAINS, include_answer: true
        }, { timeout });
        return r.data.results || [];
    } catch (error) {
        console.error('Tavily error:', error.message);
        return [];
    }
}

/**
 * Runs 4 parallel Tavily queries and returns a formatted
 * LIVE WEB DATA block, or '' if nothing found.
 * @param {string} query
 * @param {string} game
 * @returns {Promise<string>}
 */
async function searchWeb(query, game) {
    // ── Cache check ───────────────────────────────
    const cached = searchCache.get(query, game);
    if (cached) return cached;

    const t           = createTimer('Tavily');
    const currentYear = new Date().getFullYear();
    const prefix      = GAME_PREFIX[game] || 'Supercell';
    const tag         = GAME_TAG[game]    || 'strategy guide';
    const keywords    = extractSearchKeywords(query, game);

    const [q1, q2, q3, q4] = await Promise.all([
        doSearch(`"${prefix}" ${keywords} stats DPS HP ${currentYear}`),
        doSearch(`"${prefix}" ${tag} ${currentYear}`),
        doSearch(`"${prefix}" ${keywords} win rate tournament ${currentYear}`),
        doSearch(`"${prefix}" ${keywords} guide tips`, 'basic')
    ]);

    t.end();

    const seen = new Set();
    const all  = [...q1, ...q2, ...q3, ...q4].filter(r => {
        if (seen.has(r.url)) return false;
        seen.add(r.url); return true;
    });

    if (all.length === 0) {
        console.warn(`[Search] Zero results for game="${game}"`);
        return '';
    }

    const trusted   = all.filter(r =>  isTrustedSource(r.url, game));
    const untrusted = all.filter(r => !isTrustedSource(r.url, game));

    if (trusted.length === 0)
        console.warn(`[Search] No trusted sources for game="${game}"`);

    let text = '\n\n--- LIVE WEB DATA ---\n';
    trusted.slice(0, 4).forEach(r => {
        const s = (r.content || '').slice(0, 600).replace(/\n/g, ' ');
        if (s) text += `[TRUSTED] ${r.title}: ${s}\n(${r.url})\n\n`;
    });
    untrusted.slice(0, 2).forEach(r => {
        const s = (r.content || '').slice(0, 300).replace(/\n/g, ' ');
        if (s) text += `[SOURCE] ${r.title}: ${s}\n(${r.url})\n\n`;
    });

    if (!/\d+/.test(text))
        text += `\n[DATA WARNING: No specific numerical stats found. Label all estimates as "Projection (unverified)".]\n`;

    // ── Cache save ────────────────────────────────
    searchCache.set(query, game, text);

    return text;
}

module.exports = { searchWeb };
// ═══════════════════════════════════════════════════
// Game Detection Service
// Extracted from server.js for maintainability.
// ═══════════════════════════════════════════════════

// ── Keyword lists ─────────────────────────────────
const KEYWORDS = {
    coc: [
        'clash of clans','coc','clashofclans','town hall','townhall',' th1',' th2',
        ' th3',' th4',' th5',' th6',' th7',' th8',' th9',' th10',' th11',' th12',
        ' th13',' th14',' th15',' th16',' th17',
        'queen walk','bowler','super witch','blizzard','war base','farming base',
        'clan war','clan capital','builder base','trophy base','elixir collector',
        'barracks','spell factory','dark elixir','grand warden','warden',
        'archer queen','barbarian king','royal champion','smash','lavaloon',
        'witch slap','zap witch','hog rider','pekka','valkyrie',
        'wall breaker','siege machine','scattershot','inferno tower','eagle artillery',
        'root rider','super dragon','super hog','bat spell','skeleton spell',
        'fireball equipment','giant gauntlet','rage vial','frozen arrow',
        'box base','ring base','anti 3 star','war cwl','legend league'
    ],
    cr: [
        'clash royale','royale','clash royal',
        'elixir trade','deck','arena','tower','card','cycle deck',
        'goblin barrel','princess','fireball','lightning',
        'ultimate champion','challenger','grand challenge','2v2',
        'evolution','evo','mirror','mega knight','pekka bridge spam',
        'mortar','x-bow','hog cycle','miner poison','balloon royale',
        'evo knight','evo goblin','evo firecracker'
    ],
    bs: [
        'brawl stars','brawlstars',
        'brawler','trophy road','power league','ranked',
        'showdown','gem grab','brawl ball','heist','bounty',
        'mortis','spike','crow','leon','sandy','amber','gale',
        'gadget','star power','hypercharge','mastery','club league'
    ],
    wao: [
        'war and order','war & order','warandorder',
        'castle level','ancient soul','ancient souls','royal garrison',
        'beast skill','beast skills','beast talent',
        'rally','rally cap','rally attack',
        'mage troop','cavalry troop','infantry troop',
        't10','t11','t12','troop tier','march size',
        'lord talent','research tree','alliance war',
        'wonder war','migration','kingdom','medals',
        'spirit beast','dragon','gryphon','war spirit',
        'reinforcement','garrison','watchtower',
        'combat power','cp','power score','void war'
    ]
};

const GAME_TERMS = {
    coc:  ['queen','walk','root','rider','bowler','witch','hog','lavaloon','bat','warden',
           'fireball','smash','super','yeti','dragon','th16','th17','cwl','war'],
    cr:   ['deck','elixir','cycle','mega','knight','hog','balloon','pekka','miner',
           'mortar','x-bow','evo','evolution','hypercharge'],
    bs:   ['brawler','mortis','spike','crow','leon','sandy','hypercharge','gadget',
           'showdown','gem','grab','bounty','heist'],
    wao:  ['t10','t11','t12','march','rally','beast','skill','castle','ancient',
           'soul','garrison','cavalry','mage','infantry','talent','void'],
    general: []
};

const STOP_WORDS = new Set([
    'what','is','the','best','how','to','do','i','should','use','for',
    'in','a','an','or','vs','versus','and','my','can','does','which',
    'why','when','where','tell','me','about','explain','give','provide',
    'detailed','compare','between','more','consistent','starring','found',
    'analyze','analysis','breakdown','cite','statistics'
]);

// ── Public API ────────────────────────────────────

/**
 * Returns one of: 'coc' | 'cr' | 'bs' | 'wao' | 'general'
 * @param {string} query
 * @returns {string}
 */
function detectGame(query) {
    const q = query.toLowerCase();
    const scores = Object.fromEntries(
        Object.entries(KEYWORDS).map(([game, kws]) => [game, kws.filter(k => q.includes(k)).length])
    );
    const max = Math.max(...Object.values(scores));
    if (max === 0) return 'general';
    // Priority: wao > coc > cr > bs
    for (const game of ['wao', 'coc', 'cr', 'bs']) {
        if (scores[game] === max) return game;
    }
    return 'general';
}

/**
 * Extracts the most relevant search keywords from a query.
 * @param {string} query
 * @param {string} game
 * @returns {string}
 */
function extractSearchKeywords(query, game) {
    const important = GAME_TERMS[game] || [];
    const words = query.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/);
    const priority = words.filter(w => important.includes(w));
    const rest = words.filter(w => w.length > 2 && !STOP_WORDS.has(w) && !important.includes(w));
    return [...new Set([...priority, ...rest])].slice(0, 5).join(' ');
}

module.exports = { detectGame, extractSearchKeywords };
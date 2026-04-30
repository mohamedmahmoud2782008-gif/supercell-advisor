// ═══════════════════════════════════════════════════
// server.js — Production-Ready Express Server
// Applies all 8 requested improvements + extras:
//   1. Graceful Shutdown (SIGINT/SIGTERM)
//   2. Strict CORS (env-based origin)
//   3. express-rate-limit + axios-retry (see aiCallers.js)
//   4. Config via process.env (no magic numbers)
//   5. Safe SSE error handling (headersSent checks)
//   6. Fix response truncation (no .slice on history)
//   7. Patch hallucination loophole (in promptBuilder)
//   8. Aggressive Rogue Tactician (in promptBuilder)
// + Zod input validation
// + AppError taxonomy
// + TokenManager (race-condition-safe key rotation)
// + CircuitBreaker (opossum) on Groq + Gemini
// + File structure refactor
// ═══════════════════════════════════════════════════
require('dotenv').config();

const express  = require('express');
const path     = require('path');
const cors     = require('cors');
const helmet   = require('helmet');
const multer   = require('multer');
const rateLimit = require('express-rate-limit');

// ── Internal modules ──────────────────────────────
const AppError      = require('./src/errors/AppError');
const TokenManager  = require('./src/utils/TokenManager');
const { validate, chatSchema, analyzeImageSchema } = require('./src/utils/validation');
const { createBreaker } = require('./src/utils/circuitBreaker');
const { detectGame }    = require('./src/services/gameDetector');
const { searchWeb }     = require('./src/services/searchService');
const {
    buildAgents, buildRound2Angles, buildJudgeSystem,
    VISION_PROMPTS, GAME_LABELS
} = require('./src/services/promptBuilder');
const {
    callGroq, callGeminiStream, callGeminiVision,
    stripThinking, createTimer
} = require('./src/services/aiCallers');

// ═══════════════════════════════════════════════════
// Config — all magic numbers from env with fallbacks
// ═══════════════════════════════════════════════════
const PORT              = process.env.PORT                    || 3000;
const MULTER_LIMIT      = parseInt(process.env.MULTER_LIMIT_MB,    10) * 1024 * 1024 || 5 * 1024 * 1024;
const OVERALL_TIMEOUT   = parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 150_000;
const RATE_LIMIT_MAX    = parseInt(process.env.RATE_LIMIT_MAX,     10) || 8;
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000;

// ═══════════════════════════════════════════════════
// API Keys — validated at startup
// ═══════════════════════════════════════════════════
const GROQ_KEYS = [
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3
].filter(Boolean);

const GOOGLE_KEYS = [
    process.env.GOOGLE_API_KEY_1,
    process.env.GOOGLE_API_KEY_2
].filter(Boolean);

const TAVILY_KEY = process.env.TAVILY_API_KEY;

if (GROQ_KEYS.length < 1)   { console.error('MISSING GROQ_API_KEY_1');   process.exit(1); }
if (GOOGLE_KEYS.length < 1) { console.error('MISSING GOOGLE_API_KEY_1'); process.exit(1); }
if (!TAVILY_KEY)             { console.error('MISSING TAVILY_API_KEY');   process.exit(1); }

console.log(`Groq: ${GROQ_KEYS.length} keys | Google: ${GOOGLE_KEYS.length} keys`);

// ── TokenManagers (race-condition-safe) ───────────
const groqTokens   = new TokenManager(GROQ_KEYS,   'Groq');
const googleTokens = new TokenManager(GOOGLE_KEYS, 'Google');

// Pass key count to aiCallers env for retry delay calculation
process.env.GROQ_KEY_COUNT     = GROQ_KEYS.length;
process.env.GROQ_RETRY_COUNT   = GROQ_KEYS.length * 2;

// ═══════════════════════════════════════════════════
// Circuit Breakers
// ═══════════════════════════════════════════════════
const groqBreaker = createBreaker(
    (model, maxTokens, temp, messages) => callGroq(groqTokens, model, maxTokens, temp, messages),
    'Groq',
    { timeout: parseInt(process.env.GROQ_TIMEOUT_MS, 10) || 65_000 }
);
groqBreaker.fallback(() => { throw AppError.upstream('Groq unavailable — circuit open', 'GROQ_CIRCUIT_OPEN'); });

const geminiBreaker = createBreaker(
    (prompt, system, onToken) => callGeminiStream(groqTokens, googleTokens, prompt, system, onToken),
    'Gemini'
);
geminiBreaker.fallback(() => { throw AppError.upstream('Gemini unavailable — circuit open', 'GEMINI_CIRCUIT_OPEN'); });

// ═══════════════════════════════════════════════════
// Express App
// ═══════════════════════════════════════════════════
const app = express();

// ── Helmet + CSP ──────────────────────────────────
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc:  ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
            styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc:    ["'self'", "https://fonts.gstatic.com"],
            imgSrc:     ["'self'", "data:"],
            connectSrc: ["'self'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
            mediaSrc:   ["'none'"],
            objectSrc:  ["'none'"],
            baseUri:    ["'self'"],
            formAction: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" }
}));

// ── CORS — Fix #2: strict origin from env ─────────
app.use(cors({
    origin:  process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
    methods: ['GET', 'POST']
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate Limiting — Fix #3: express-rate-limit ────
// Easily swappable to Redis store for clustering:
//   const RedisStore = require('rate-limit-redis');
//   store: new RedisStore({ ... })
const limiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW,
    max:      RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders:   false,
    message: { error: 'Too many requests. Wait a minute.' },
    // store: new RedisStore({ ... })  ← uncomment for Redis
});

// ── Multer — Fix #4: limit from env ───────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: MULTER_LIMIT },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(AppError.badRequest('Only image files allowed', 'INVALID_FILE_TYPE'));
    }
});

// ═══════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════

/** SSE helper — Fix #5: safe write with headersSent check */
function send(res, data) {
    try {
        if (res.writableEnded) return;
        const j = JSON.stringify(data);
        if (!j.includes('\n')) res.write(`data: ${j}\n\n`);
    } catch (e) {
        console.warn('[SSE] write failed:', e.message);
    }
}

/**
 * Sends an error through the correct channel.
 * - If SSE headers not sent yet → use HTTP status
 * - If SSE already started       → send via SSE data payload (Fix #5)
 */
function sendError(res, statusCode, message, code = 'ERROR') {
    if (!res.headersSent) {
        res.status(statusCode).json({ error: message, code });
    } else {
        send(res, { type: 'error', code: statusCode, message });
        if (!res.writableEnded) res.end();
    }
}

// ── Agent runner ──────────────────────────────────
async function runAgentsParallel(agents, buildPrompt, onDone, round) {
    const results = {};
    const tRound  = createTimer(`Round ${round}`);
    const baseDelay = Math.max(1000, Math.floor(4000 / groqTokens.size));

    await Promise.all(agents.map((agent, index) =>
        (async () => {
            await new Promise(r => setTimeout(r, index * baseDelay));
            const tAgent = createTimer(`R${round}/${agent.id}`);
            try {
                const gr = await groqBreaker.fire(agent.model, agent.max_tokens, agent.temp, buildPrompt(agent));
                results[agent.id] = stripThinking(gr.data.choices[0].message.content || '');
                tAgent.end();
                onDone(agent, false);
            } catch (e) {
                console.error(`R${round} ${agent.id}:`, e.message);
                results[agent.id] = 'Analysis unavailable.';
                tAgent.end();
                onDone(agent, true);
            }
        })()
    ));

    tRound.end();
    return results;
}

// ═══════════════════════════════════════════════════
// ROUTE: Image Analysis
// ═══════════════════════════════════════════════════
app.post('/analyze-image',
    limiter,
    upload.single('image'),
    validate(analyzeImageSchema),
    async (req, res, next) => {
        if (!req.file) return next(AppError.badRequest('No image uploaded.', 'NO_FILE'));

        const { query: userQuery, game } = req.body;
        console.log(`[Image] game=${game} size=${req.file.size}`);

        try {
            const basePrompt = VISION_PROMPTS[game] || VISION_PROMPTS.general;
            const fullPrompt = userQuery ? `User question: "${userQuery}"\n\n${basePrompt}` : basePrompt;
            const analysis   = await callGeminiVision(googleTokens, req.file.buffer, req.file.mimetype, fullPrompt);
            res.json({ analysis, game, gameLabel: GAME_LABELS[game], model: 'gemini-vision' });
        } catch (err) {
            next(err);
        }
    }
);

// ═══════════════════════════════════════════════════
// ROUTE: /chat — Text Debate (SSE)
// Fix #4: timeout from env
// Fix #5: safe SSE error handling throughout
// Fix #6: no .slice() on history values
// ═══════════════════════════════════════════════════
app.post('/chat',
    limiter,
    validate(chatSchema),
    async (req, res) => {

        // Set SSE headers FIRST — must happen before any async work
        res.status(200);
        res.setHeader('Content-Type',  'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection',    'keep-alive');
        res.flushHeaders();

        // ── Fix #4 + Fix #5: overall timeout from env ──
        const overallTimeout = setTimeout(() => {
            console.error('[Timeout] Request exceeded limit');
            // Fix #5: headers already sent → use SSE, not HTTP status
            send(res, { type: 'error', code: 408, message: 'Request timed out. Please try again.' });
            if (!res.writableEnded) res.end();
        }, OVERALL_TIMEOUT);

        const cleanup = () => clearTimeout(overallTimeout);
        req.on('close', () => { cleanup(); console.log('Client disconnected early.'); });

        const tTotal    = createTimer('Total request');
        const userQuery = req.body.userQuery; // Already validated + sanitized by Zod

        const game          = detectGame(userQuery);
        const AGENTS        = buildAgents(game);
        const ROUND2_ANGLES = buildRound2Angles(game);

        console.log(`[Request] Game: ${GAME_LABELS[game]} | "${userQuery.slice(0, 80)}"`);

        try {
            // ── Search ─────────────────────────────────
            send(res, {
                type: 'status', round: 'prep', game, gameLabel: GAME_LABELS[game],
                message: `Searching verified ${GAME_LABELS[game]} data...`,
                agents: [{ id: 'search', name: 'Web Search', emoji: '🌐' }]
            });

            const web      = await searchWeb(userQuery, game);
            const webBlock = web
                ? `\n\nLIVE WEB DATA (ONLY source for stats):\n${web}\nREMINDER: Every number needs its URL.`
                : '\n\nNO WEB DATA FOUND. Label ALL analysis as "Projection (unverified)".';

            // ── Round 1 ────────────────────────────────
            send(res, {
                type: 'status', round: 1, message: 'Round 1 — Expert Analysis',
                agents: AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, status: 'thinking' }))
            });

            const round1 = await runAgentsParallel(
                AGENTS,
                (agent) => [
                    { role: 'system', content: agent.system + webBlock },
                    { role: 'user',   content: `QUESTION: ${userQuery}` }
                ],
                (agent, err) => send(res, {
                    type: 'agent_done', round: 1,
                    agentId: agent.id, agentName: agent.name, agentEmoji: agent.emoji,
                    ...(err ? { error: true } : {})
                }),
                1
            );
            send(res, { type: 'round_complete', round: 1 });

            // ── Round 2 ────────────────────────────────
            send(res, {
                type: 'status', round: 2, message: 'Round 2 — Cross-Examination',
                agents: AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, status: 'thinking' }))
            });

            const targets = { agent1: 'agent2', agent2: 'agent3', agent3: 'agent1' };

            const round2 = await runAgentsParallel(
                AGENTS,
                (agent) => [
                    { role: 'system',    content: agent.system + webBlock },
                    { role: 'assistant', content: round1[agent.id] || '' },
                    {
                        role: 'user', content:
`QUESTION: ${userQuery}
Opponent R1: "${round1[targets[agent.id]] || ''}"
YOUR ATTACK ANGLE: ${ROUND2_ANGLES[agent.id]}
MISSION:
1) Quote opponent claim — verified in LIVE WEB DATA or not?
2) Add NEW evidence from LIVE WEB DATA or BASELINE (label which).
3) Scenario where opponent strategy fails.
4) Decisive closing statement.
Do NOT repeat Round 1 arguments.`
                    }
                ],
                (agent, err) => send(res, {
                    type: 'agent_done', round: 2,
                    agentId: agent.id, agentName: agent.name, agentEmoji: agent.emoji,
                    ...(err ? { error: true } : {})
                }),
                2
            );
            send(res, { type: 'round_complete', round: 2 });

            // ── Grand Champion ─────────────────────────
            const tJudge = createTimer('Judge');
            send(res, {
                type: 'status', round: 'judge', message: 'Grand Champion deliberating...',
                agents: [{ id: 'judge', name: 'Grand Champion', emoji: '⚖️', status: 'thinking' }]
            });

            // Fix #6: full strings — NO .slice(0, 500) on history
            const history = AGENTS.map(a =>
                `${a.emoji} ${a.name}:\nR1: ${round1[a.id]}\nR2: ${round2[a.id]}`
            ).join('\n\n---\n');

            let judgeAnswer = await geminiBreaker.fire(
`QUESTION: "${userQuery}"
Game: ${GAME_LABELS[game]}

=== LIVE WEB DATA ===\n${web}\n=== END ===

=== DEBATE ===\n${history}\n=== END ===

STEP 1: List every [TRUSTED] number (verified).
STEP 2: List every BASELINE number agents used (mark "baseline").
STEP 3: Rule on STEP 1 first, STEP 2 second.
STEP 4: Confidence = 0-1 verified → Low | 2-4 → Medium | 5+ → High.

Issue GRAND CHAMPION ruling now.`,
                buildJudgeSystem(userQuery, game),
                (token) => send(res, { type: 'token', token })
            );
            tJudge.end();

            const urls = [...judgeAnswer.matchAll(/https?:\/\/[^\s)\]"]+/g)]
                .map(m => m[0]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);

            judgeAnswer += urls.length
                ? `\n\n---\nVerified Sources:\n${urls.map((u, i) => `[${i + 1}] ${u}`).join('\n')}\nVerify before ranked play.`
                : '\n\n---\nNo external URLs — baseline knowledge only. Verify before ranked play.';

            tTotal.end();

            // Fix #6: send FULL round1/round2 strings — no truncation
            send(res, {
                type: 'final',
                answer:    judgeAnswer,
                game,
                gameLabel: GAME_LABELS[game],
                history: {
                    agents: AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji })),
                    round1: Object.fromEntries(Object.entries(round1).map(([k, v]) => [k, v])),
                    round2: Object.fromEntries(Object.entries(round2).map(([k, v]) => [k, v]))
                }
            });

            cleanup();
            res.end();

        } catch (err) {
            console.error('[/chat] Fatal:', err.message);
            cleanup();
            // Fix #5: safe error — check headersSent
            if (!res.headersSent) {
                res.status(500).json({ error: 'Server error. Please try again.' });
            } else {
                send(res, { type: 'error', code: 500, message: 'Server error. Please try again.' });
                if (!res.writableEnded) res.end();
            }
        }
    }
);

// ═══════════════════════════════════════════════════
// Global Error Handler
// Catches AppError + unexpected errors from all routes
// ═══════════════════════════════════════════════════
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    // Multer errors
    if (err.code === 'LIMIT_FILE_SIZE')
        err = AppError.payloadTooLarge(`File too large. Max ${MULTER_LIMIT / 1024 / 1024}MB.`);

    const isAppError = err instanceof AppError;
    const status     = isAppError ? err.statusCode : 500;
    const message    = isAppError ? err.message    : 'Internal server error.';
    const code       = isAppError ? err.code       : 'INTERNAL_ERROR';

    if (!isAppError || !err.isOperational) {
        console.error('[Unhandled Error]', err);
    }

    // SSE responses use send(); everything else uses JSON
    if (res.headersSent) {
        send(res, { type: 'error', code: status, message });
        if (!res.writableEnded) res.end();
    } else {
        const body = { error: message, code };
        if (err.issues) body.issues = err.issues; // Zod validation details
        res.status(status).json(body);
    }
});

// ═══════════════════════════════════════════════════
// Health Check — معلومات كاملة للـ monitoring
// ═══════════════════════════════════════════════════
const searchCache = require('./src/utils/searchCache');
const _startTime  = Date.now();

app.get('/health', (req, res) => res.json({
    status:     'ok',
    uptime:     `${Math.floor(process.uptime())}s`,
    memoryMB:   Math.round(process.memoryUsage().rss / 1024 / 1024),
    groqKeys:   groqTokens.size,
    googleKeys: googleTokens.size,
    circuits: {
        groq:   groqBreaker.opened   ? 'OPEN' : 'CLOSED',
        gemini: geminiBreaker.opened ? 'OPEN' : 'CLOSED'
    },
    cache: searchCache.stats()
}));

// ── robots.txt ────────────────────────────────────
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send(`User-agent: *\nAllow: /\nSitemap: ${process.env.ALLOWED_ORIGIN || 'http://localhost:3000'}/sitemap.xml`);
});

// ── sitemap.xml ───────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
    const base = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';
    res.type('application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>`);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═══════════════════════════════════════════════════
// Startup — Fix #1: Graceful Shutdown
// ═══════════════════════════════════════════════════
const server = app.listen(PORT, '0.0.0.0', () =>
    console.log(`\nSupercell AI Advisor → http://localhost:${PORT}\n`)
);

function gracefulShutdown(signal) {
    console.log(`\n[${signal}] Shutting down gracefully...`);
    server.close((err) => {
        if (err) {
            console.error('[Shutdown] Error closing server:', err);
            process.exit(1);
        }
        console.log('[Shutdown] All connections closed. Goodbye.');
        process.exit(0);
    });

    // Force-kill if connections hang beyond 15s
    setTimeout(() => {
        console.error('[Shutdown] Forced exit after 15s timeout.');
        process.exit(1);
    }, 15_000).unref();
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Catch unhandled promise rejections — log, don't crash
process.on('unhandledRejection', (reason) => {
    console.error('[UnhandledRejection]', reason);
});
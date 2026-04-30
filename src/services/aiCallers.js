// ═══════════════════════════════════════════════════
// AI Caller Service
//
// Fix #3 (revised): axios-retry handles backoff timing;
// TokenManager handles key rotation separately.
// This way we keep the smart key-rotation behaviour
// while removing the manual for-loop retry boilerplate.
//
// Install: npm install axios-retry
// ═══════════════════════════════════════════════════
const axios      = require('axios');
const axiosRetry = require('axios-retry').default ?? require('axios-retry');
const TokenManager = require('../utils/TokenManager');
const AppError     = require('../errors/AppError');

// ── Axios instances (one per upstream) ───────────
const groqAxios   = axios.create();
const geminiAxios = axios.create();

// ── axios-retry config ────────────────────────────
//
// For Groq: on 429 / 503 we retry up to (keys * 2) times.
// Each retry we also advance the key via TokenManager.
// The delay is handled entirely by axios-retry's
// exponentialDelay — no manual setTimeout needed.

const GROQ_RETRIES    = parseInt(process.env.GROQ_RETRY_COUNT,   10) || 6; // ~GROQ_KEYS.length * 2
const GEMINI_RETRIES  = parseInt(process.env.GEMINI_RETRY_COUNT, 10) || 4;

axiosRetry(groqAxios, {
    retries: GROQ_RETRIES,
    retryCondition: (err) => {
        const s = err.response?.status;
        return s === 429 || s === 503 || axiosRetry.isNetworkError(err);
    },
    retryDelay: (retryCount, err) => {
        const base = parseInt(process.env.GROQ_BASE_DELAY_MS, 10) || 1000;
        const keys = parseInt(process.env.GROQ_KEY_COUNT,      10) || 1;
        // Dynamic delay respects key pool size (same logic as original getDynamicDelay)
        const pool = Math.max(1000, Math.floor(4000 / keys));
        const delay = pool + (retryCount * base);
        console.warn(`[Groq] Retry ${retryCount} — waiting ${delay}ms`);
        return delay;
    },
    onRetry: (retryCount, err, config) => {
        // Rotate to the next key on every retry
        if (config._groqManager) {
            config.headers['Authorization'] = `Bearer ${config._groqManager.next()}`;
        }
    }
});

axiosRetry(geminiAxios, {
    retries: GEMINI_RETRIES,
    retryCondition: (err) => {
        const s = err.response?.status;
        return s === 429 || s === 503 || axiosRetry.isNetworkError(err);
    },
    retryDelay: (retryCount) => {
        const delay = (retryCount + 1) * 7_000;
        console.warn(`[Gemini] Retry ${retryCount} — waiting ${delay}ms`);
        return delay;
    }
});

// ── Helpers ───────────────────────────────────────

function stripThinking(text) {
    if (!text) return text;
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    text = text.replace(/^(okay[,.]?|alright[,.]?|let me|let's|i need to|first[,.]?|so[,.]?)\s+/i, '').trim();
    return text;
}

function createTimer(label) {
    const start = Date.now();
    return { end: () => console.log(`[⏱ ${label}] ${Date.now() - start}ms`) };
}

// ── Groq Caller ───────────────────────────────────

/**
 * Calls Groq chat completions with built-in retry + key rotation.
 *
 * @param {TokenManager} tokenManager
 * @param {string}       model
 * @param {number}       maxTokens
 * @param {number}       temp
 * @param {Array}        messages
 */
async function callGroq(tokenManager, model, maxTokens, temp, messages) {
    const timeout = parseInt(process.env.GROQ_TIMEOUT_MS, 10) || 60_000;
    const key     = tokenManager.next();

    const config = {
        headers: {
            'Authorization':  `Bearer ${key}`,
            'Content-Type':   'application/json'
        },
        timeout,
        // Attach manager so onRetry can rotate the key
        _groqManager: tokenManager
    };

    try {
        return await groqAxios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            { model, messages, max_tokens: maxTokens, temperature: temp, stream: false },
            config
        );
    } catch (err) {
        const s = err.response?.status;
        throw AppError.upstream(
            `Groq request failed (${s || err.message})`,
            'GROQ_UPSTREAM_ERROR'
        );
    }
}

// ── Gemini Models Fallback List ───────────────────
const GEMINI_MODELS = [
    'gemini-3-flash-preview',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
];

/**
 * Streams a Gemini response, calling onToken for each chunk.
 * Falls back to Groq (GPT-OSS 120B) if ALL Gemini models fail.
 *
 * @param {TokenManager} groqManager
 * @param {TokenManager} googleManager
 * @param {string}       prompt
 * @param {string}       system
 * @param {Function}     onToken  - callback(tokenString)
 * @returns {Promise<string>}     - full assembled answer
 */
async function callGeminiStream(groqManager, googleManager, prompt, system, onToken) {
    const streamTimeout = parseInt(process.env.GEMINI_STREAM_TIMEOUT_MS, 10) || 90_000;
    const reqTimeout    = parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS, 10) || 120_000;

    for (const model of GEMINI_MODELS) {
        for (let attempt = 0; attempt < googleManager.size; attempt++) {
            const key = googleManager.next();
            try {
                console.log(`[Gemini] Trying ${model} (attempt ${attempt + 1})`);
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${key}&alt=sse`;
                const resp = await geminiAxios.post(url, {
                    system_instruction: { parts: [{ text: system }] },
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { maxOutputTokens: 1800, temperature: 0.3 }
                }, { responseType: 'stream', timeout: reqTimeout });

                let answer = '', buf = '';
                await new Promise((resolve, reject) => {
                    const st = setTimeout(() => reject(new Error('stream timeout')), streamTimeout);
                    resp.data.on('data', chunk => {
                        buf += chunk.toString();
                        const lines = buf.split('\n'); buf = lines.pop();
                        for (const line of lines) {
                            if (!line.startsWith('data:')) continue;
                            const js = line.slice(5).trim();
                            if (!js || js === '[DONE]') continue;
                            try {
                                const token = JSON.parse(js)?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                                if (token) { answer += token; onToken(token); }
                            } catch (e) { console.warn(`[Gemini SSE] ${model}: ${e.message}`); }
                        }
                    });
                    resp.data.on('end',   () => { clearTimeout(st); resolve(); });
                    resp.data.on('error', (e) => { clearTimeout(st); reject(e); });
                });

                console.log(`[Gemini] Success: ${model}`);
                return answer;
            } catch (err) {
                const s = err.response?.status;
                console.warn(`[Gemini] [${model}] attempt ${attempt + 1} -> ${s || err.message}`);
                if (s !== 429 && s !== 503 && err.message !== 'stream timeout') break;
                // exponential back-off handled by axiosRetry for non-stream failures;
                // for stream errors we wait manually since the stream is already open
                if (err.message === 'stream timeout') {
                    await new Promise(r => setTimeout(r, (attempt + 1) * 7_000));
                }
            }
        }
    }

    // ── Groq fallback for Judge ───────────────────
    console.warn('[Judge] All Gemini failed → Groq GPT-OSS 120B fallback');
    const gr = await callGroq(groqManager, 'openai/gpt-oss-120b', 1800, 0.3, [
        { role: 'system', content: system },
        { role: 'user',   content: prompt }
    ]);
    const answer = stripThinking(gr.data.choices[0].message.content || '');
    onToken(answer);
    return answer;
}

/**
 * Calls Gemini Vision for image analysis (non-streaming).
 *
 * @param {TokenManager} googleManager
 * @param {Buffer}       imageBuffer
 * @param {string}       mimeType
 * @param {string}       fullPrompt
 * @returns {Promise<string>}
 */
async function callGeminiVision(googleManager, imageBuffer, mimeType, fullPrompt) {
    const visionModels = ['gemini-3-flash-preview', 'gemini-2.0-flash', 'gemini-1.5-flash'];
    const timeout      = parseInt(process.env.GEMINI_VISION_TIMEOUT_MS, 10) || 45_000;

    for (const model of visionModels) {
        for (let attempt = 0; attempt < googleManager.size; attempt++) {
            const key = googleManager.next();
            try {
                console.log(`[Vision] Trying ${model}...`);
                const url  = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
                const resp = await geminiAxios.post(url, {
                    contents: [{
                        parts: [
                            { text: fullPrompt },
                            { inline_data: { mime_type: mimeType, data: imageBuffer.toString('base64') } }
                        ]
                    }],
                    generationConfig: { maxOutputTokens: 1200, temperature: 0.2 }
                }, { timeout });

                const text = resp.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                console.log(`[Vision] Success: ${model}`);
                return text;
            } catch (err) {
                const s = err.response?.status;
                console.warn(`[Vision] ${model} attempt ${attempt + 1} -> ${s || err.message}`);
                if (s !== 429 && s !== 503) break;
                await new Promise(r => setTimeout(r, (attempt + 1) * 5_000));
            }
        }
    }
    throw AppError.upstream('Image analysis failed — all vision models unavailable', 'VISION_UPSTREAM_ERROR');
}

module.exports = { callGroq, callGeminiStream, callGeminiVision, stripThinking, createTimer };
// API Service - Supports both OpenRouter and Google Gemini

const OPENROUTER_API_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_API_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent';
const OPENROUTER_MODEL = 'google/gemma-3-27b-it:free';
const API_TIMEOUT_MS = 30000;

/**
 * fetch() with an automatic timeout.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs  - default API_TIMEOUT_MS (30 seconds)
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timerId);
        return response;
    } catch (err) {
        clearTimeout(timerId);
        if (err.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
        }
        throw err;
    }
}

/**
 * Get current API provider and key from storage
 */
async function getApiConfig() {
    const sync = await chrome.storage.sync.get(['apiProvider']);
    const local = await chrome.storage.local.get(['apiKey', 'geminiKey']);

    const provider = sync.apiProvider || 'gemini';
    const apiKey = provider === 'gemini' ? local.geminiKey : local.apiKey;

    return { provider, apiKey };
}

/**
 * Unified API caller - routes to correct provider
 */
async function callAPI(messages, apiKeyOverride = null) {
    const config = await getApiConfig();

    // Only use override if it matches the current provider type
    // This prevents OpenRouter key from being used for Gemini and vice versa
    let apiKey = config.apiKey;
    if (apiKeyOverride && config.provider === 'openrouter') {
        // Only use override for OpenRouter (legacy support)
        apiKey = apiKeyOverride;
    }

    if (!apiKey) {
        throw new Error('No API key configured for ' + config.provider);
    }

    if (config.provider === 'gemini') {
        return await callGemini(messages, apiKey);
    } else {
        return await callOpenRouter(messages, apiKey);
    }
}

/**
 * Helper to call OpenRouter API
 */
async function callOpenRouter(messages, apiKey) {
    if (rateLimitManager.isBlocked('openrouter')) {
        const secs = rateLimitManager.secondsRemaining('openrouter');
        throw new Error(`Rate limited. Please wait ${secs}s before trying again.`);
    }

    try {
        const response = await fetchWithTimeout(OPENROUTER_API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://github.com/InclusiveRead',
                'X-Title': 'InclusiveRead Extension'
            },
            body: JSON.stringify({
                model: OPENROUTER_MODEL,
                messages: messages
            })
        });

        if (!response.ok) {
            if (response.status === 429) {
                const rawRetryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
                // Clamp to reasonable bounds (1s–3600s) to avoid malicious/misconfigured servers
                const retryAfter = Math.min(Math.max(1, rawRetryAfter), 3600);
                rateLimitManager.markLimited('openrouter', retryAfter);
                throw new Error(`Rate limited. Please wait ${retryAfter}s before trying again.`);
            }
            const errorData = await response.json().catch(() => ({}));
            // Handle various error response formats
            const errorMsg = errorData.error?.message
                || errorData.message
                || (typeof errorData.error === 'string' ? errorData.error : null)
                || `HTTP ${response.status}: ${response.statusText}`;
            errorTracker.record('callOpenRouter', errorMsg, { status: response.status });
            throw new Error(errorMsg);
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    } catch (error) {
        if (!error.message?.includes('Rate limited') && !error.message?.includes('timed out')) {
            errorTracker.record('callOpenRouter', error, { provider: 'openrouter' });
        }
        throw error;
    }
}

/**
 * Helper to call Google Gemini API
 */
async function callGemini(messages, apiKey) {
    if (rateLimitManager.isBlocked('gemini')) {
        const secs = rateLimitManager.secondsRemaining('gemini');
        throw new Error(`Rate limited. Please wait ${secs}s before trying again.`);
    }

    try {
        // Convert OpenAI-style messages to Gemini format
        const contents = messages.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));

        // API key is sent via header (not URL) to avoid exposure in logs/history
        const response = await fetchWithTimeout(GEMINI_API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
            },
            body: JSON.stringify({
                contents: contents,
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 2048
                }
            })
        });

        if (!response.ok) {
            if (response.status === 429) {
                const rawRetryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
                // Clamp to reasonable bounds (1s–3600s) to avoid malicious/misconfigured servers
                const retryAfter = Math.min(Math.max(1, rawRetryAfter), 3600);
                rateLimitManager.markLimited('gemini', retryAfter);
                throw new Error(`Rate limited. Please wait ${retryAfter}s before trying again.`);
            }
            const errorData = await response.json().catch(() => ({}));
            // Handle various error response formats
            const errorMsg = errorData.error?.message
                || errorData.message
                || (typeof errorData.error === 'string' ? errorData.error : null)
                || `HTTP ${response.status}: ${response.statusText}`;
            errorTracker.record('callGemini', errorMsg, { status: response.status });
            throw new Error(errorMsg);
        }

        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch (error) {
        if (!error.message?.includes('Rate limited') && !error.message?.includes('timed out')) {
            errorTracker.record('callGemini', error, { provider: 'gemini' });
        }
        throw error;
    }
}

/**
 * Detect and simplify jargon - Enhanced version
 */
async function detectJargon(pageText, apiKey, options = {}) {
    const { category = 'all', contextHints = [] } = options;

    // Pre-process text to extract meaningful content
    const cleanText = pageText
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s.,;:'"()-]/g, '')
        .trim();

    const prompt = `You are an expert accessibility assistant helping neurodivergent users understand complex terminology.

CONTEXT: Analyze this webpage content and identify terms that may be difficult to understand.

PAGE CONTENT:
"""
${cleanText.slice(0, 4000)}
"""

YOUR TASK:
1. Identify complex terms in these categories:
   - LEGAL: contracts, agreements, liability, terms of service
   - FINANCIAL: fees, payments, billing, transactions
   - TECHNICAL: software, digital, computing terms
   - MEDICAL: health, conditions, treatments
   - GOVERNMENT: regulations, policies, bureaucratic language
   - ACADEMIC: formal, scholarly language

2. For each term provide:
   - The exact term as it appears (preserve case)
   - A simple 2-4 word alternative
   - A brief explanation (max 15 words)
   - Category (legal/financial/technical/medical/government/academic)
   - Difficulty level (1-3, where 3 is most complex)

3. PRIORITIZE:
   - Terms related to user actions or decisions
   - Terms that could cause confusion or anxiety
   - Terms with legal or financial implications
   - Acronyms and abbreviations

RESPOND with valid JSON array only (no markdown):
[
  {
    "jargon": "exact term",
    "simple": "easy alternative",
    "explanation": "brief context in plain English",
    "category": "legal|financial|technical|medical|government|academic",
    "difficulty": 1-3
  }
]

Return up to 15 terms, sorted by importance. If no complex terms found, return empty array [].`;

    try {
        // Use unified API caller (routes to OpenRouter or Gemini based on settings)
        const text = await callAPI([{ role: 'user', content: prompt }], apiKey);

        // Extract JSON from response
        const jsonMatch = text.match(/\[[\s\S]*?\]/);
        if (!jsonMatch) {
            console.warn('No valid JSON array in jargon response');
            return [];
        }

        let parsed;
        try {
            parsed = JSON.parse(jsonMatch[0]);
        } catch (parseError) {
            errorTracker.record('detectJargon', parseError, { stage: 'JSON.parse' });
            return [];
        }

        return ResponseValidator.validateJargonList(parsed);
    } catch (error) {
        errorTracker.record('detectJargon', error, { provider: (await getApiConfig().catch(() => ({}))).provider });
        return [];
    }
}

/**
 * Simplify text into plain, easy-to-understand English
 */
async function simplifyText(text, apiKey) {
    const cleanText = text
        .replace(/\s+/g, ' ')
        .trim();

    const prompt = `You are a plain language expert helping neurodivergent users understand complex text.

ORIGINAL TEXT:
"""
${cleanText.slice(0, 3000)}
"""

YOUR TASK:
Rewrite this text in SIMPLE, PLAIN ENGLISH that is easy to understand.

RULES:
1. Use short sentences (max 15 words each)
2. Use common, everyday words
3. Avoid jargon, technical terms, and formal language
4. Break down complex ideas into simple steps
5. Use active voice ("We will send" not "It will be sent")
6. Explain any necessary technical terms in parentheses
7. Keep the same meaning and all important information
8. Use bullet points for lists when helpful
9. Write at a 6th-grade reading level

RESPOND with valid JSON only (no markdown):
{
  "simplified": "the rewritten text in plain English",
  "readingLevel": "estimated grade level (e.g., '6th grade')",
  "keyChanges": ["brief list of main simplifications made"]
}`;

    try {
        // Use unified API caller (routes to OpenRouter or Gemini based on settings)
        const response = await callAPI([{ role: 'user', content: prompt }], apiKey);

        // Extract JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn('No valid JSON in simplify response');
            return null;
        }

        let parsed;
        try {
            parsed = JSON.parse(jsonMatch[0]);
        } catch (parseError) {
            errorTracker.record('simplifyText', parseError, { stage: 'JSON.parse' });
            return null;
        }

        return ResponseValidator.validateSimplifiedText(parsed);
    } catch (error) {
        errorTracker.record('simplifyText', error, { provider: (await getApiConfig().catch(() => ({}))).provider });
        return null;
    }
}

/**
 * Test API key validity for the specified provider
 * @param {string} apiKey - The API key to test
 * @param {string} provider - The provider to test ('openrouter' or 'gemini')
 */
async function testApiKey(apiKey, provider = 'openrouter') {
    try {
        const testMessage = [{ role: 'user', content: 'Say hello' }];

        if (provider === 'gemini') {
            await callGemini(testMessage, apiKey);
        } else {
            await callOpenRouter(testMessage, apiKey);
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Export for background script
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        detectJargon,
        simplifyText,
        testApiKey
    };
}

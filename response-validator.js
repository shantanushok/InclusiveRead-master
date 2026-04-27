// Response Validator - Validates and sanitises AI API responses

class ResponseValidator {
    /**
     * Validate and sanitise a jargon-detection response array.
     * @param {unknown} raw  - parsed JSON value
     * @returns {Array<{jargon: string, simple: string, explanation: string, category: string, difficulty: number}>}
     */
    static validateJargonList(raw) {
        if (!Array.isArray(raw)) return [];
        return raw
            .filter(item => item && typeof item === 'object')
            .map(item => ({
                jargon:      ResponseValidator._safeStr(item.jargon,      50),
                simple:      ResponseValidator._safeStr(item.simple,      100),
                explanation: ResponseValidator._safeStr(item.explanation, 200),
                category:    ResponseValidator._safeEnum(item.category,
                               ['legal', 'financial', 'technical', 'medical', 'government', 'academic'], 'general'),
                difficulty:  ResponseValidator._safeInt(item.difficulty, 1, 3, 2)
            }))
            .filter(item => item.jargon.length >= 3 && item.simple.length >= 1);
    }

    /**
     * Validate a simplify-text response object.
     * @param {unknown} raw  - parsed JSON value
     * @returns {{simplified: string, readingLevel: string, keyChanges: string[]}|null}
     */
    static validateSimplifiedText(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const simplified = ResponseValidator._safeStr(raw.simplified, 10000);
        if (!simplified) return null;
        return {
            simplified,
            readingLevel: ResponseValidator._safeStr(raw.readingLevel, 50) || 'Unknown',
            keyChanges:   Array.isArray(raw.keyChanges)
                ? raw.keyChanges.map(c => ResponseValidator._safeStr(c, 200)).filter(Boolean)
                : []
        };
    }

    /** Clamp a string to maxLen and strip HTML/script tags. */
    static _safeStr(val, maxLen) {
        if (typeof val !== 'string') return '';
        return val
            .replace(/<[^>]*>/g, '')   // strip any HTML tags
            .trim()
            .slice(0, maxLen);
    }

    static _safeEnum(val, allowed, fallback) {
        return allowed.includes(val) ? val : fallback;
    }

    static _safeInt(val, min, max, fallback) {
        const n = parseInt(val, 10);
        return isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
    }
}

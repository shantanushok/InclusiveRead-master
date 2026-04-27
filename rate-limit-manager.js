// Rate Limit Manager - Handles API rate limiting with exponential backoff

class RateLimitManager {
    constructor() {
        // provider → { blocked: bool, unblockAt: number, retryCount: number }
        this.state = {};
    }

    /** Mark a provider as rate-limited for `retryAfterSeconds`. */
    markLimited(provider, retryAfterSeconds = 60) {
        this.state[provider] = {
            blocked: true,
            unblockAt: Date.now() + retryAfterSeconds * 1000,
            retryCount: (this.state[provider]?.retryCount || 0) + 1
        };
        console.warn(`[InclusiveRead] ${provider} rate-limited for ${retryAfterSeconds}s`);
    }

    /** Check if provider is currently blocked. */
    isBlocked(provider) {
        const s = this.state[provider];
        if (!s?.blocked) return false;
        if (Date.now() >= s.unblockAt) {
            s.blocked = false;
            return false;
        }
        return true;
    }

    /** Seconds until a blocked provider is available again (0 if not blocked). */
    secondsRemaining(provider) {
        const s = this.state[provider];
        if (!s?.blocked) return 0;
        return Math.max(0, Math.ceil((s.unblockAt - Date.now()) / 1000));
    }

    /**
     * Exponential-backoff retry wrapper.
     * @param {Function} fn        - async function to retry
     * @param {number}   maxTries  - default 3
     * @param {number}   baseMs    - initial delay in ms, default 1000
     */
    async withRetry(fn, maxTries = 3, baseMs = 1000) {
        for (let attempt = 1; attempt <= maxTries; attempt++) {
            try {
                return await fn();
            } catch (err) {
                const isRateLimit = err.message?.includes('429') ||
                                    err.message?.toLowerCase().includes('rate limit');
                if (isRateLimit && attempt < maxTries) {
                    const delay = baseMs * Math.pow(2, attempt - 1);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw err;
            }
        }
    }
}

const rateLimitManager = new RateLimitManager();

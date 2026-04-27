// Error Tracker - Structured error logging for InclusiveRead

class APIErrorTracker {
    constructor() {
        this.errors = [];
        this.MAX_STORED = 50; // keep last 50 errors in memory
    }

    /**
     * Record a structured error event.
     * @param {string} source  - e.g. 'callGemini', 'callOpenRouter'
     * @param {Error|string} error
     * @param {object} [meta]  - optional context (provider, endpoint, etc.)
     */
    record(source, error, meta = {}) {
        const entry = {
            timestamp: Date.now(),
            source,
            message: error?.message || String(error),
            meta
        };
        this.errors.push(entry);
        if (this.errors.length > this.MAX_STORED) {
            this.errors.shift();
        }
        console.error(`[InclusiveRead] ${source}:`, entry.message, meta);
        // Persist last error to storage for popup diagnostics
        chrome.storage.local.set({ lastError: entry }).catch((err) => {
            console.warn('[InclusiveRead] Failed to persist error to storage:', err);
        });
    }

    /** Return last N errors. */
    recent(n = 10) {
        return this.errors.slice(-n);
    }

    /** Clear all tracked errors. */
    clear() {
        this.errors = [];
        chrome.storage.local.remove('lastError').catch((err) => {
            console.warn('[InclusiveRead] Failed to clear error from storage:', err);
        });
    }
}

const errorTracker = new APIErrorTracker();

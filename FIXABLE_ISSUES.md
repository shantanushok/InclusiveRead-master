# InclusiveRead — Comprehensive Fix-It Guide

> **How to use this document:** Issues are sorted from easiest to hardest. Start at Tier 1 and work downward. Each entry has a severity badge, a problem description with real code references, a concrete fix with code snippets, an impact note, and a progress checklist you can tick off as you go.

---

## Table of Contents

1. [Tier 1 — Code-Level Fixes (hours)](#tier-1--code-level-fixes-hours)
   - [1.1 Missing Error Logging & Monitoring](#11-missing-error-logging--monitoring)
   - [1.2 Missing Rate Limit Handling](#12-missing-rate-limit-handling)
   - [1.3 No Timeout Protection](#13-no-timeout-protection)
   - [1.4 No Input Validation for AI Responses](#14-no-input-validation-for-ai-responses)
   - [1.5 API Key Exposed in URLs — SECURITY](#15-api-key-exposed-in-urls--security)
   - [1.6 No XSS Protection in Content Injection](#16-no-xss-protection-in-content-injection)
   - [1.7 Missing Request Deduplication](#17-missing-request-deduplication)
2. [Tier 2 — Architectural Fixes (days)](#tier-2--architectural-fixes-days)
   - [2.1 Missing Content Detection for Sensory Shield](#21-missing-content-detection-for-sensory-shield)
   - [2.2 No Caching for Repeated Page Visits](#22-no-caching-for-repeated-page-visits)
   - [2.3 No Feature Flags for Staged Rollout](#23-no-feature-flags-for-staged-rollout)
   - [2.4 CSS Conflicts with Dyslexia Mode](#24-css-conflicts-with-dyslexia-mode)
3. [Tier 3 — Fundamental Problems (discussion required)](#tier-3--fundamental-problems-discussion-required)
   - [3.1 AI Accuracy & Hallucination in Critical Domains](#31-ai-accuracy--hallucination-in-critical-domains)
   - [3.2 Feature Complexity Overwhelm](#32-feature-complexity-overwhelm)
   - [3.3 Browser Coverage & Maintainability](#33-browser-coverage--maintainability)
   - [3.4 Monetization & Sustainability](#34-monetization--sustainability)
4. [Implementation Priority Matrix](#implementation-priority-matrix)
5. [Next Steps](#next-steps)

---

## Tier 1 — Code-Level Fixes (hours)

These are pure code changes. No architecture decisions are required. Each can be completed independently in a single sitting.

---

### 1.1 Missing Error Logging & Monitoring

**Severity:** 🟠 High  
**Files:** `gemini-service.js`, `background.js`, `content.js`

#### Problem

All errors are swallowed with `console.error` and silent `return []` / `return null`. There is no structured error tracking, no categorisation, and no way to observe failure patterns across users. When the AI call silently fails, the user sees nothing and the developer learns nothing.

```js
// gemini-service.js — current state
} catch (error) {
    console.error('Jargon detection failed:', error);
    return [];   // ← silent failure, user sees no feedback
}
```

```js
// background.js — current state
} catch (error) {
    return { success: false, error: error.message };   // ← no record kept
}
```

#### Impact

- Impossible to know how often the extension breaks in the wild.
- Regression bugs go unnoticed until users complain.
- Developers cannot triage which API errors (rate limits vs. auth vs. network) dominate.

#### Fix — `APIErrorTracker` class

Add the following utility to `gemini-service.js` (or a new `error-tracker.js` file that is imported via `importScripts`):

```js
// error-tracker.js  (new file)
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
        chrome.storage.local.set({ lastError: entry }).catch(() => {});
    }

    /** Return last N errors. */
    recent(n = 10) {
        return this.errors.slice(-n);
    }

    /** Clear all tracked errors. */
    clear() {
        this.errors = [];
        chrome.storage.local.remove('lastError').catch(() => {});
    }
}

const errorTracker = new APIErrorTracker();
```

Then replace bare `console.error` calls in `gemini-service.js`:

```js
// before
} catch (error) {
    console.error('Jargon detection failed:', error);
    return [];
}

// after
} catch (error) {
    errorTracker.record('detectJargon', error, { provider: config?.provider });
    return [];
}
```

#### Progress

- [ ] Create `error-tracker.js`
- [ ] Add `importScripts('error-tracker.js')` in `background.js`
- [ ] Replace `console.error` calls in `gemini-service.js` with `errorTracker.record`
- [ ] Expose `errorTracker.recent()` to popup settings panel for user-visible diagnostics

---

### 1.2 Missing Rate Limit Handling

**Severity:** 🔴 Critical  
**Files:** `gemini-service.js`

#### Problem

Both API callers (`callOpenRouter`, `callGemini`) treat HTTP 429 (Too Many Requests) the same as any other error — they throw immediately with no retry, no backoff, and no user guidance.

```js
// gemini-service.js — current state
if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMsg = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
    throw new Error(errorMsg);
    // ↑ No distinction between 429 rate-limit and 500 server error
}
```

#### Impact

- Free-tier Gemini and OpenRouter both have aggressive rate limits; real users hit them.
- The extension silently fails with a generic "error" toast, giving no guidance.
- No automatic retry means a transient limit causes permanent failure for that session.

#### Fix — `RateLimitManager` class

```js
// rate-limit-manager.js  (new file)
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
```

Update the fetch wrappers in `gemini-service.js`:

```js
// inside callGemini / callOpenRouter — replace the !response.ok block:
if (!response.ok) {
    if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
        rateLimitManager.markLimited(provider, retryAfter);
        throw new Error(`Rate limited. Please wait ${retryAfter}s before trying again.`);
    }
    // … existing error handling …
}
```

#### Progress

- [ ] Create `rate-limit-manager.js`
- [ ] Add `importScripts('rate-limit-manager.js')` in `background.js`
- [ ] Handle HTTP 429 separately in `callGemini` and `callOpenRouter`
- [ ] Surface "rate limited — try in Xs" message to user via `showNotification` in `content.js`
- [ ] Check `rateLimitManager.isBlocked(provider)` before each API call to fail fast

---

### 1.3 No Timeout Protection

**Severity:** 🟠 High  
**Files:** `gemini-service.js`

#### Problem

API calls have no `timeout` option. On a slow network or if the AI provider stalls, `fetch` will hang indefinitely. The user sees a spinner with no resolution.

```js
// gemini-service.js — current state
const response = await fetch(GEMINI_API_ENDPOINT + '?key=' + apiKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig })
    // ↑ No AbortSignal, no timeout
});
```

#### Impact

- User is stuck watching a loader that will never finish.
- Background service worker can be tied up for minutes on a single request.
- On mobile Chrome or throttled connections this is effectively a UI freeze.

#### Fix — `fetchWithTimeout` wrapper

```js
/**
 * fetch() with an automatic timeout.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs  - default 30 seconds
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
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
```

Replace both `fetch(...)` calls in `callGemini` and `callOpenRouter` with `fetchWithTimeout(...)`.

#### Progress

- [ ] Add `fetchWithTimeout` to `gemini-service.js`
- [ ] Replace `fetch` in `callOpenRouter` with `fetchWithTimeout`
- [ ] Replace `fetch` in `callGemini` with `fetchWithTimeout`
- [ ] Expose timeout duration as a named constant (`API_TIMEOUT_MS = 30000`) at the top of `gemini-service.js`
- [ ] Show "Request timed out" user notification in `content.js` catch blocks

---

### 1.4 No Input Validation for AI Responses

**Severity:** 🟠 High  
**Files:** `gemini-service.js`

#### Problem

Responses from the AI are parsed with `JSON.parse` directly after a regex match. There is minimal structure validation, and no defence against:

- Malformed or truncated JSON
- Injected fields with unexpected types
- Arrays where objects are expected (and vice versa)
- Response strings that contain executable content

```js
// gemini-service.js — current state
let result = JSON.parse(jsonMatch[0]);

// Validate and clean results
result = result.filter(item =>
    item.jargon && item.simple &&
    item.jargon.length >= 3 && item.jargon.length <= 50
);
// ↑ No type checks, no sanitisation of string content
```

#### Impact

- A corrupted AI response causes an unhandled exception that cascades to a generic error.
- An adversarially crafted API response (man-in-the-middle, rogue proxy) could inject arbitrary strings that later reach the DOM.
- Field type mismatches (e.g. `difficulty` arriving as a string) silently corrupt the rendered output.

#### Fix — `ResponseValidator` class

```js
// response-validator.js  (new file)
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
                               ['legal','financial','technical','medical','government','academic'], 'general'),
                difficulty:  ResponseValidator._safeInt(item.difficulty, 1, 3, 2)
            }))
            .filter(item => item.jargon.length >= 3 && item.simple.length >= 1);
    }

    /**
     * Validate a simplify-text response object.
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
```

Usage in `gemini-service.js`:

```js
// Replace manual filter/map with:
return ResponseValidator.validateJargonList(JSON.parse(jsonMatch[0]));
```

#### Progress

- [ ] Create `response-validator.js`
- [ ] Add `importScripts('response-validator.js')` in `background.js`
- [ ] Replace manual result filtering in `detectJargon` with `ResponseValidator.validateJargonList`
- [ ] Replace manual result validation in `simplifyText` with `ResponseValidator.validateSimplifiedText`
- [ ] Add try/catch around `JSON.parse` calls with `errorTracker.record` fallback

---

### 1.5 API Key Exposed in URLs — SECURITY

**Severity:** 🔴 Critical  
**Files:** `gemini-service.js`

#### Problem

The Google Gemini API key is appended as a URL query parameter. This means the key appears in:

- Browser history
- Server access logs
- Proxy logs
- Network inspection tools (DevTools, Wireshark)
- Any analytics or CDN layer between the user and Google's servers

```js
// gemini-service.js — line 94 (CURRENT — INSECURE)
const response = await fetch(`${GEMINI_API_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // ↑ key is in the URL — visible in logs and history
```

#### Impact

- API keys can be harvested from browser history or corporate proxy logs.
- Users sharing a device could inadvertently expose each other's keys.
- A user's Gemini quota could be silently stolen by a third party who has access to logs.

#### Fix — Move API key to `Authorization` header

Google's Gemini API supports `Bearer` token authentication via the `Authorization` header (or `x-goog-api-key`):

```js
// gemini-service.js — FIXED
async function callGemini(messages, apiKey) {
    try {
        const contents = messages.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));

        const response = await fetchWithTimeout(GEMINI_API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey   // ← key in header, NOT query string
            },
            body: JSON.stringify({
                contents,
                generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
            })
        });
        // … rest unchanged …
    }
}
```

> **Note:** `GEMINI_API_ENDPOINT` should no longer include `?key=` — remove that suffix entirely and update the constant.

#### Progress

- [ ] Update `GEMINI_API_ENDPOINT` constant — remove `?key=` pattern
- [ ] Add `'x-goog-api-key': apiKey` to the headers object in `callGemini`
- [ ] Remove `?key=${apiKey}` from the fetch URL in `callGemini`
- [ ] Test that authentication still works with the header-based approach
- [ ] Update `privacy_policy.md` to reflect that keys are never sent as URL parameters

---

### 1.6 No XSS Protection in Content Injection

**Severity:** 🔴 Critical  
**Files:** `content.js`

#### Problem

When the extension renders AI-generated content into the page (jargon tooltips, simplified text panels, notification toasts), it uses `innerHTML` in several places. If an AI response, a page's text content, or a crafted input contains HTML or script tags, those tags will be executed in the context of the page.

```js
// content.js — example pattern (representative of multiple locations)
tooltipEl.innerHTML = `
    <div class="ir-jargon-simple">${item.simple}</div>
    <div class="ir-jargon-explanation">${item.explanation}</div>
`;
// ↑ item.simple and item.explanation come from AI — not sanitised
```

#### Impact

- A malicious or hallucinating AI response containing `<script>` or event-handler attributes executes arbitrary JavaScript on the visited page.
- An attacker who can influence the AI response (e.g., via prompt injection embedded in page content) can steal cookies, read form fields, or exfiltrate data.
- This is a **stored XSS** risk when jargon maps are cached.

#### Fix — Safe DOM construction methods

Replace every `innerHTML` assignment that uses dynamic data with explicit DOM API calls:

```js
// UNSAFE — do not use for dynamic content
tooltipEl.innerHTML = `<strong>${item.simple}</strong>: ${item.explanation}`;

// SAFE — use textContent and createElement
function buildTooltipContent(item) {
    const wrapper = document.createElement('div');

    const simpleEl = document.createElement('div');
    simpleEl.className = 'ir-jargon-simple';
    simpleEl.textContent = item.simple;   // ← textContent never parses HTML

    const explanationEl = document.createElement('div');
    explanationEl.className = 'ir-jargon-explanation';
    explanationEl.textContent = item.explanation;

    wrapper.appendChild(simpleEl);
    wrapper.appendChild(explanationEl);
    return wrapper;
}
tooltipEl.appendChild(buildTooltipContent(item));
```

For cases where HTML structure is needed (e.g. icon SVGs), keep those as static strings and only inject user/AI content via `textContent`.

**Audit checklist** — search `content.js` for each of these patterns and replace:

```
innerHTML = `...${
innerHTML = '...' + 
.insertAdjacentHTML(
```

#### Progress

- [ ] Audit all `innerHTML` assignments in `content.js` that include dynamic data
- [ ] Replace dynamic `innerHTML` assignments with `textContent` + `createElement` builders
- [ ] Audit `popup.js` for the same pattern
- [ ] Add `ResponseValidator._safeStr` call before any string is inserted into the DOM (defence-in-depth)
- [ ] Verify fix by injecting `<img src=x onerror=alert(1)>` as a jargon term and confirming it renders as text

---

### 1.7 Missing Request Deduplication

**Severity:** 🟡 Medium  
**Files:** `content.js`, `background.js`

#### Problem

If the user toggles Jargon Decoder rapidly, or if a page dispatches multiple load events, multiple identical API calls fire concurrently. There is no mechanism to detect that an identical request is already in-flight and reuse its result.

```js
// content.js — activateJargonDecoder
async function activateJargonDecoder() {
    // ... no check: is an identical request already in-flight?
    const response = await chrome.runtime.sendMessage({
        action: 'detectJargon',
        pageText: pageText,
        // ↑ same pageText sent twice if toggle fires twice in quick succession
    });
}
```

#### Impact

- Doubles API usage (burning free quota faster).
- Race conditions between two concurrent responses can corrupt `state.jargonMap`.
- On slow connections, a second request starts before the first completes, causing UI flicker.

#### Fix — `RequestDeduplicator` class

```js
// request-deduplicator.js  (new file)
class RequestDeduplicator {
    constructor() {
        this._pending = new Map(); // key → Promise
    }

    /**
     * Execute `fn` only if no request with the same `key` is already in-flight.
     * Concurrent callers with the same key receive the same Promise.
     * @param {string}   key  - unique request identifier (e.g. hash of pageText)
     * @param {Function} fn   - async function that performs the real work
     */
    async dedupe(key, fn) {
        if (this._pending.has(key)) {
            return this._pending.get(key);
        }
        const promise = fn().finally(() => this._pending.delete(key));
        this._pending.set(key, promise);
        return promise;
    }

    /** Hash a string to a short key (FNV-1a, good enough for deduplication). */
    static hashKey(str) {
        let hash = 2166136261;
        for (let i = 0; i < Math.min(str.length, 500); i++) {
            hash ^= str.charCodeAt(i);
            hash = (hash * 16777619) >>> 0;
        }
        return hash.toString(16);
    }
}

const requestDeduplicator = new RequestDeduplicator();
```

Usage in `content.js`:

```js
async function activateJargonDecoder() {
    const pageText = getPageText();
    const key = RequestDeduplicator.hashKey(pageText);

    return requestDeduplicator.dedupe(key, async () => {
        // … existing API call logic …
    });
}
```

#### Progress

- [ ] Create `request-deduplicator.js`
- [ ] Initialise `requestDeduplicator` in `content.js`
- [ ] Wrap `activateJargonDecoder` API call in `requestDeduplicator.dedupe`
- [ ] Wrap `decodeSelectedText` API call in `requestDeduplicator.dedupe`
- [ ] Wrap `simplifySelectedText` API call in `requestDeduplicator.dedupe`

---

## Tier 2 — Architectural Fixes (days)

These require more thought about structure, but still have clear solution paths. Tackle them after Tier 1 is complete.

---

### 2.1 Missing Content Detection for Sensory Shield

**Severity:** 🟠 High  
**Files:** `dom-utils.js`, `content.js`

#### Problem

The Sensory Shield freezes CSS animations with `animation-play-state: paused !important`. This approach misses the large and growing category of JavaScript-driven animations:

- `requestAnimationFrame` loops
- GSAP / anime.js / Motion One libraries
- CSS Houdini Worklets
- Canvas animations
- WebGL scenes

```js
// dom-utils.js — detectAnimations()
allElements.forEach(el => {
    const style = window.getComputedStyle(el);
    const hasAnimation = style.animationName !== 'none' && style.animationName !== '';
    // ↑ Only detects CSS keyframe animations
    // ↑ No detection of rAF loops, canvas, or third-party animation libraries
});
```

Additionally, the current code pauses **all** animations including essential UI feedback: loading spinners, focus rings, skeleton screens.

#### Impact

- Pages built with React Spring, Framer Motion, or GSAP remain fully animated.
- Pausing every animation breaks perceived functionality (users think the page is frozen).
- Autistic and sensory-sensitive users get incomplete protection.

#### Fix

**Step 1 — Intercept `requestAnimationFrame`** (content script, injected early):

```js
// Patch rAF to allow pausing
const _originalRaf = window.requestAnimationFrame.bind(window);
const _rafCallbacks = new Map();
let _rafPaused = false;

window.requestAnimationFrame = function(callback) {
    if (_rafPaused) {
        // Queue but don't execute
        const id = Math.random();
        _rafCallbacks.set(id, callback);
        return id;
    }
    return _originalRaf(callback);
};

function pauseJSAnimations() { _rafPaused = true; }
function resumeJSAnimations() {
    _rafPaused = false;
    _rafCallbacks.forEach(cb => _originalRaf(cb));
    _rafCallbacks.clear();
}
```

**Step 2 — Allowlist essential animations** by checking ARIA roles and element semantics before pausing:

```js
const ESSENTIAL_SELECTORS = [
    '[role="progressbar"]',
    '[role="status"]',
    '.loading',
    '[aria-busy="true"]'
];

function isEssentialAnimation(el) {
    return ESSENTIAL_SELECTORS.some(sel => el.matches(sel));
}
```

**Step 3 — Pause canvas/video** (already partially present — expand coverage):

```js
document.querySelectorAll('canvas').forEach(canvas => {
    // Tag canvas for later resume
    canvas.dataset.irPaused = 'true';
    // Freeze by replacing the drawing context
});
```

#### Progress

- [ ] Add rAF patching code to `content.js` (runs before page scripts via `run_at: document_start` — requires manifest change)
- [ ] Implement `isEssentialAnimation` allowlist in `dom-utils.js`
- [ ] Update `detectAnimations` to flag JS-driven animations separately
- [ ] Update `activateSensoryShield` to call `pauseJSAnimations()`
- [ ] Update `deactivateSensoryShield` to call `resumeJSAnimations()`
- [ ] Add `<canvas>` and `<video>` pausing/resuming to the shield

---

### 2.2 No Caching for Repeated Page Visits

**Severity:** 🟠 High  
**Files:** `gemini-service.js`, `content.js`

#### Problem

Every time the user visits the same page (or re-enables the Jargon Decoder on the same tab), a fresh API call is made. There is no caching layer. This wastes free-tier API quota, increases latency, and makes the extension feel slow on return visits.

```js
// content.js — activateJargonDecoder
// Every call goes straight to the background API handler
const response = await chrome.runtime.sendMessage({
    action: 'detectJargon',
    pageText: pageText,
    // ↑ No cache check before sending
});
```

#### Fix — `PersistentJargonCache` with IndexedDB

`chrome.storage.local` has a 5 MB limit. For a jargon cache that can hold hundreds of URL results, IndexedDB is more appropriate.

```js
// jargon-cache.js  (new file)
class PersistentJargonCache {
    constructor(dbName = 'InclusiveReadCache', version = 1) {
        this.dbName = dbName;
        this.version = version;
        this._db = null;
        this.TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    }

    async _open() {
        if (this._db) return this._db;
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, this.version);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('jargon')) {
                    const store = db.createObjectStore('jargon', { keyPath: 'urlHash' });
                    store.createIndex('timestamp', 'timestamp');
                }
            };
            req.onsuccess = e => { this._db = e.target.result; resolve(this._db); };
            req.onerror = () => reject(req.error);
        });
    }

    /** Generate a short hash for the URL (strip query params for stability). */
    static urlHash(url) {
        const clean = url.split('?')[0].split('#')[0];
        let h = 2166136261;
        for (let i = 0; i < clean.length; i++) {
            h ^= clean.charCodeAt(i);
            h = (h * 16777619) >>> 0;
        }
        return h.toString(16);
    }

    async get(url) {
        try {
            const db = await this._open();
            const key = PersistentJargonCache.urlHash(url);
            return new Promise((resolve) => {
                const tx = db.transaction('jargon', 'readonly');
                const req = tx.objectStore('jargon').get(key);
                req.onsuccess = () => {
                    const entry = req.result;
                    if (!entry) return resolve(null);
                    if (Date.now() - entry.timestamp > this.TTL_MS) return resolve(null); // expired
                    resolve(entry.data);
                };
                req.onerror = () => resolve(null);
            });
        } catch { return null; }
    }

    async set(url, data) {
        try {
            const db = await this._open();
            const key = PersistentJargonCache.urlHash(url);
            return new Promise((resolve) => {
                const tx = db.transaction('jargon', 'readwrite');
                tx.objectStore('jargon').put({ urlHash: key, data, timestamp: Date.now() });
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve(); // fail silently
            });
        } catch { /* ignore */ }
    }

    /** Evict entries older than TTL. Call periodically. */
    async evictStale() {
        try {
            const db = await this._open();
            const cutoff = Date.now() - this.TTL_MS;
            const tx = db.transaction('jargon', 'readwrite');
            const store = tx.objectStore('jargon');
            const index = store.index('timestamp');
            const range = IDBKeyRange.upperBound(cutoff);
            index.openCursor(range).onsuccess = e => {
                const cursor = e.target.result;
                if (cursor) { cursor.delete(); cursor.continue(); }
            };
        } catch { /* ignore */ }
    }
}

const jargonCache = new PersistentJargonCache();
```

Usage in `content.js`:

```js
async function activateJargonDecoder() {
    const currentUrl = window.location.href;

    // 1. Cache hit?
    const cached = await jargonCache.get(currentUrl);
    if (cached) {
        applyJargonMap(cached);
        return;
    }

    // 2. Cache miss — call API
    const pageText = getPageText();
    const response = await chrome.runtime.sendMessage({ action: 'detectJargon', pageText });

    if (response.success && response.data.length > 0) {
        await jargonCache.set(currentUrl, response.data);
        applyJargonMap(response.data);
    }
}
```

#### Progress

- [ ] Create `jargon-cache.js`
- [ ] Add cache check at the top of `activateJargonDecoder` in `content.js`
- [ ] Populate cache on successful API response
- [ ] Add a "Clear cache" button to the settings panel in `popup.html` / `popup.js`
- [ ] Call `jargonCache.evictStale()` on extension install/update in `background.js`
- [ ] Expose cache hit/miss stats in popup diagnostics panel

---

### 2.3 No Feature Flags for Staged Rollout

**Severity:** 🟡 Medium  
**Files:** `background.js`, `popup.js`

#### Problem

All four features are always available to all users. There is no way to:

- Roll out a new feature to a subset of users first (A/B test)
- Disable a broken feature remotely without publishing a new extension version
- Offer beta features to opted-in testers

#### Impact

- A bug in a new feature affects 100% of users immediately.
- Can't gather data on feature adoption before committing to maintenance.
- No kill switch if an AI prompt change causes widespread bad output.

#### Fix — `FeatureFlags` class with remote override support

```js
// feature-flags.js  (new file)
const FEATURE_DEFAULTS = {
    jargonDecoder:   true,
    sensoryShield:   true,
    dyslexiaMode:    true,
    textToSpeech:    true,
    selectionDecode: true,
    jargonCache:     false,  // new — disabled until stable
    rateLimit:       true
};

class FeatureFlags {
    constructor(defaults = FEATURE_DEFAULTS) {
        this._flags = { ...defaults };
    }

    /** Load flags from chrome.storage (supports remote config override). */
    async load() {
        const stored = await chrome.storage.sync.get('featureFlags').catch(() => ({}));
        if (stored.featureFlags && typeof stored.featureFlags === 'object') {
            // Only allow overrides for known flags
            for (const key of Object.keys(FEATURE_DEFAULTS)) {
                if (key in stored.featureFlags) {
                    this._flags[key] = !!stored.featureFlags[key];
                }
            }
        }
    }

    /** Check if a feature is enabled. */
    isEnabled(feature) {
        return !!this._flags[feature];
    }

    /** Enable/disable a feature and persist. */
    async set(feature, enabled) {
        if (!(feature in FEATURE_DEFAULTS)) return;
        this._flags[feature] = !!enabled;
        const stored = await chrome.storage.sync.get('featureFlags').catch(() => ({}));
        await chrome.storage.sync.set({
            featureFlags: { ...stored.featureFlags, [feature]: !!enabled }
        });
    }

    /** Return a copy of all current flags. */
    all() { return { ...this._flags }; }
}

const featureFlags = new FeatureFlags();
```

Gate features in `content.js` / `background.js`:

```js
// content.js — init()
await featureFlags.load();

if (featureFlags.isEnabled('jargonDecoder') && state.jargonEnabled) {
    await activateJargonDecoder();
}
if (featureFlags.isEnabled('sensoryShield') && state.sensoryEnabled) {
    activateSensoryShield();
}
// …
```

#### Progress

- [ ] Create `feature-flags.js`
- [ ] Add `importScripts('feature-flags.js')` in `background.js`
- [ ] Call `featureFlags.load()` during `init()` in `content.js`
- [ ] Gate each `activate*` call behind the corresponding flag
- [ ] Add a "Beta Features" section to the settings panel in `popup.html`
- [ ] Document the flag schema in `CONTRIBUTING.md`

---

### 2.4 CSS Conflicts with Dyslexia Mode

**Severity:** 🟠 High  
**Files:** `content.js`, `content.css`

#### Problem

Dyslexia mode injects global CSS rules targeting `body`, `p`, `h1`–`h6`, etc. Many modern websites use `!important` declarations or CSS-in-JS runtimes (Emotion, styled-components) that re-apply their own styles on every render. This means:

1. The extension's font/spacing overrides may be immediately overwritten by the page.
2. The page's layout can break when the extension's spacing changes element dimensions.
3. Single-page applications re-render components and lose the extension's applied styles.

```js
// content.js — activateDyslexiaMode (representative)
injectCSS(`
    body, p, li, td, th, div, span {
        font-family: 'OpenDyslexic', sans-serif !important;
        letter-spacing: ${settings.letterSpacing}px !important;
    }
`, 'ir-dyslexia-styles');
// ↑ Global rules that fight with !important in the page's own CSS
```

#### Impact

- Dyslexia mode silently fails on heavily styled sites (Medium, GitHub, Notion, Google Docs).
- Layout breaks create cognitive friction — the opposite of the extension's goal.
- Users blame the extension (correctly) and disable it.

#### Fix

**Strategy A — Specificity escalation (quick win):**

Instead of targeting tag names, target a class added to `<html>` and use descendant selectors to outspecify page CSS:

```css
/* content.css */
html.ir-dyslexia-active body *:not([class*="ir-"]) {
    font-family: var(--ir-dyslexia-font, 'OpenDyslexic') !important;
    letter-spacing: var(--ir-letter-spacing, 1px) !important;
    line-height: var(--ir-line-height, 1.6) !important;
    word-spacing: var(--ir-word-spacing, 3px) !important;
}
```

Set CSS variables on `:root` when settings change instead of injecting new style blocks:

```js
function updateDyslexiaSettings(settings) {
    const root = document.documentElement;
    root.style.setProperty('--ir-dyslexia-font', fontMap[settings.font]);
    root.style.setProperty('--ir-letter-spacing', `${settings.letterSpacing}px`);
    root.style.setProperty('--ir-line-height', settings.lineHeight);
    root.style.setProperty('--ir-word-spacing', `${settings.wordSpacing}px`);
}
```

**Strategy B — MutationObserver re-application (robust fix):**

Watch for DOM mutations on SPA pages and re-apply styles:

```js
function watchDyslexiaMutations() {
    const observer = new MutationObserver(() => {
        if (state.dyslexiaEnabled) {
            document.documentElement.classList.add('ir-dyslexia-active');
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
}
```

#### Progress

- [ ] Add `ir-dyslexia-active` class toggling to `activateDyslexiaMode` / `deactivateDyslexiaMode`
- [ ] Move dyslexia font/spacing rules into `content.css` scoped under `html.ir-dyslexia-active`
- [ ] Replace inline style injection with CSS variable updates on `:root`
- [ ] Add `MutationObserver` to re-add class after SPA navigation
- [ ] Test on at least: GitHub, Medium, Notion, Google Search results

---

## Tier 3 — Fundamental Problems (discussion required)

These issues cannot be resolved with code alone. They require decisions about product direction, resources, or external partnerships. This section frames each problem and proposes potential paths forward.

---

### 3.1 AI Accuracy & Hallucination in Critical Domains

**Severity:** 🔴 Critical  
**Type:** Product / Legal risk

#### Problem

The Jargon Decoder and Text Simplifier use general-purpose AI models (Gemma 3, Gemini) to simplify legal contracts, medical information, and government documents. These models **hallucinate** — they confidently produce incorrect simplifications that look accurate to a non-expert reader.

A neurodivergent user relying on an AI-simplified version of a tenancy contract, medical consent form, or benefits application could make real-world decisions based on incorrect information.

> There is no disclaimer, confidence indicator, or fallback in the current implementation.

#### Options for Discussion

| Option | Effort | Risk Reduction |
|--------|--------|----------------|
| **A. Add a prominent disclaimer** on all AI output ("This simplification may be inaccurate. Verify with the original.") | Low | Low |
| **B. Confidence scoring** — show users when AI certainty is low (requires fine-tuned model or multiple-model agreement) | High | Medium |
| **C. Domain-specific curated glossaries** — pre-built, human-verified term lists for legal/medical/government that override AI | Medium | High |
| **D. Hybrid approach** — AI for initial detection, human-verified glossary for critical categories | High | High |
| **E. Scope limitation** — explicitly exclude legal, medical, and government categories from AI simplification | Low | High |

#### Progress Tracking

- [ ] Decide on approach (team discussion)
- [ ] Add a legal disclaimer to the UI for all AI-generated content
- [ ] Draft list of domains where AI output will NOT be shown without verification
- [ ] Evaluate feasibility of curated glossary for top 3 critical domains

---

### 3.2 Feature Complexity Overwhelm

**Severity:** 🟠 High  
**Type:** UX / Adoption

#### Problem

The popup contains four independent feature areas, each with multiple sub-settings. Users see toggles, sliders, dropdowns, and API key fields on first open. For users with ADHD or executive dysfunction — the core target audience — this is a significant cognitive barrier.

There is no "recommended" mode, no "start here" guidance, and no simplified entry point.

#### Options for Discussion

| Option | Effort | Expected Impact |
|--------|--------|-----------------|
| **A. Preset profiles** — "Dyslexia", "ADHD", "Sensory Sensitive", "All On" single-click modes | Low–Medium | High adoption |
| **B. Progressive disclosure** — show only 2–3 core toggles by default; hide advanced settings | Low | Medium |
| **C. Onboarding wizard** — step-by-step first-run experience that asks about needs and configures accordingly | Medium | High |
| **D. Feature usage analytics** — measure which features are used; remove or demote unused ones | Medium (requires privacy-safe telemetry) | Data-driven |

#### Progress Tracking

- [ ] Decide on preset strategy (team discussion)
- [ ] Design reduced "simple mode" popup with 3 core toggles
- [ ] Implement presets as stored settings bundles in `background.js`
- [ ] Add "Recommended for [condition]" labels to each preset

---

### 3.3 Browser Coverage & Maintainability

**Severity:** 🟡 Medium  
**Type:** Technical / Strategic

#### Problem

The extension targets Chrome (Manifest V3). Several issues exist:

1. **Firefox:** MV3 support is incomplete in Firefox. The extension will not load without changes.
2. **Safari:** Requires a separate Xcode project and Safari Web Extension conversion. Significant effort.
3. **No automated testing:** No test framework exists. Refactoring any core function risks silent regressions.
4. **No CI/CD:** No GitHub Actions workflow for linting, testing, or automated packaging.

#### Options for Discussion

| Option | Effort | Value |
|--------|--------|-------|
| **A. Add Firefox compatibility layer** (polyfill `browser` vs `chrome` namespace) | Low | Medium (Firefox has significant neurodivergent user base) |
| **B. Add Jest + jsdom test suite** for utility functions | Medium | High (prevents regressions) |
| **C. Add GitHub Actions CI** for linting and packaging | Low | High (quality gate) |
| **D. Safari via Xcode** | High | Low (low priority given maintenance cost) |

#### Progress Tracking

- [ ] Add `webextension-polyfill` for Firefox compatibility
- [ ] Create `.github/workflows/ci.yml` for lint + build check
- [ ] Write unit tests for `gemini-service.js` utility functions
- [ ] Write unit tests for `dom-utils.js` functions
- [ ] Document browser support matrix in `README.md`

---

### 3.4 Monetization & Sustainability

**Severity:** 🟡 Medium  
**Type:** Business / Strategic

#### Problem

The extension relies entirely on users supplying their own free-tier API keys. This creates friction:

- Users must create and manage accounts on OpenRouter or Google AI Studio.
- Free API tiers have rate limits that degrade the experience.
- The developer has no revenue to fund ongoing maintenance.

If both free APIs change their terms, the extension's core feature (Jargon Decoder) becomes non-functional overnight with no fallback.

#### Options for Discussion

| Option | Effort | Sustainability |
|--------|--------|----------------|
| **A. Status quo** — BYOK (Bring Your Own Key), always free | None | Fragile |
| **B. Hosted API proxy** — manage a shared API key, offer generous free tier to users | High | Medium (operational cost) |
| **C. Freemium model** — core CSS features free, AI features require account | Medium | Better |
| **D. One-time purchase** (e.g. via Chrome Web Store in-app payments) | Low–Medium | Simple |
| **E. Grant funding** — accessibility tools may qualify for disability inclusion grants (Google.org, etc.) | Medium | Sustainable |
| **F. Local LLM fallback** — integrate WebLLM/Transformers.js for on-device inference | High | Fully offline |

#### Progress Tracking

- [ ] Define which features must remain free (CSS accessibility features)
- [ ] Evaluate hosted proxy cost vs. expected usage
- [ ] Research grant eligibility (accessibility / neurodivergent inclusion)
- [ ] Prototype WebLLM integration for on-device fallback (spike: 2–3 days)

---

## Implementation Priority Matrix

| ID  | Issue | Severity | Effort | Priority |
|-----|-------|----------|--------|----------|
| 1.5 | API Key in URL (Security) | 🔴 Critical | 30 min | **P0 — Do now** |
| 1.6 | XSS in Content Injection | 🔴 Critical | 2–3 h | **P0 — Do now** |
| 1.2 | Rate Limit Handling | 🔴 Critical | 1–2 h | **P1 — This week** |
| 1.3 | Timeout Protection | 🟠 High | 1 h | **P1 — This week** |
| 1.1 | Error Logging | 🟠 High | 2 h | **P1 — This week** |
| 1.4 | AI Response Validation | 🟠 High | 2 h | **P1 — This week** |
| 1.7 | Request Deduplication | 🟡 Medium | 2 h | **P2 — Next week** |
| 2.4 | CSS Dyslexia Conflicts | 🟠 High | 1 day | **P2 — Next week** |
| 2.1 | Sensory Shield JS Animations | 🟠 High | 2 days | **P2 — Next week** |
| 2.2 | Jargon Caching | 🟠 High | 1 day | **P3 — This sprint** |
| 2.3 | Feature Flags | 🟡 Medium | 1 day | **P3 — This sprint** |
| 3.1 | AI Hallucination / Disclaimers | 🔴 Critical | Discussion | **P1 — Discuss now** |
| 3.2 | UX Complexity / Presets | 🟠 High | Discussion + 2 days | **P2 — Next sprint** |
| 3.3 | Browser Coverage & Testing | 🟡 Medium | 3–5 days | **P3 — Roadmap** |
| 3.4 | Monetization Strategy | 🟡 Medium | Discussion | **P4 — Roadmap** |

### Quick Wins (complete in a single session)

1. `1.5` — Remove `?key=` from Gemini URL → move to `x-goog-api-key` header
2. `1.3` — Add `fetchWithTimeout` wrapper (30 lines of code)
3. `1.2` — Add `RateLimitManager` and handle HTTP 429
4. Add disclaimer text to all AI output panels

### Medium Term (complete in a week)

5. `1.6` — Audit and fix all `innerHTML` assignments
6. `1.1` — Add `APIErrorTracker`
7. `1.4` — Add `ResponseValidator`
8. `2.4` — Refactor dyslexia CSS to use CSS variables + `html.ir-dyslexia-active`

### Strategic (requires planning and discussion)

9. `2.2` — IndexedDB jargon cache
10. `2.1` — rAF interception for Sensory Shield
11. `3.1` — Curated glossary for critical domains
12. `3.2` — Preset profiles in popup UI

---

## Next Steps

### Immediate actions (open a PR for each)

1. Fix `1.5` — security patch for API key in URL
2. Fix `1.3` — add `fetchWithTimeout`
3. Fix `1.2` — add `RateLimitManager` + 429 handling
4. Fix `1.6` — replace `innerHTML` with safe DOM builders

### Before discussing Tier 3

- [ ] Read through all Tier 1 fixes and confirm scope with team
- [ ] Complete at least the P0 security fixes (`1.5`, `1.6`)
- [ ] Identify which Tier 3 issue is most urgent for your user base
- [ ] Set up a user feedback channel (GitHub Discussions, or a simple form)

---

## File Reference Index

| File | Issues Referenced |
|------|-------------------|
| `gemini-service.js` | 1.1, 1.2, 1.3, 1.4, 1.5 |
| `content.js` | 1.6, 1.7, 2.1, 2.2, 2.3, 2.4 |
| `background.js` | 1.1, 1.2, 1.4, 2.3 |
| `dom-utils.js` | 2.1 |
| `popup.js` / `popup.html` | 1.6, 2.3, 3.2 |
| `content.css` | 2.4 |
| `manifest.json` | 2.1 (run_at change), 3.3 |
| New: `error-tracker.js` | 1.1 |
| New: `rate-limit-manager.js` | 1.2 |
| New: `response-validator.js` | 1.4 |
| New: `request-deduplicator.js` | 1.7 |
| New: `jargon-cache.js` | 2.2 |
| New: `feature-flags.js` | 2.3 |

---

*Last updated: 2026-04-27 — tracked in this repository as `FIXABLE_ISSUES.md`*

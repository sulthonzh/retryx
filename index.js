/**
 * retryx — Zero-dep retry with exponential backoff, jitter, and predicates.
 *
 * @module retryx
 */

/**
 * Default jitter strategy: "full" — random between 0 and the computed delay.
 * Strategies:
 *   - "none":       delay = base * factor^(attempt-1), capped at maxDelay
 *   - "full":       random(0, computed) — spreads load well
 *   - "equal":      computed/2 + random(0, computed/2) — tighter spread
 *   - "decorrelated": based on previous delay (prevents synchronization)
 */

/**
 * Compute delay for a given attempt using exponential backoff + jitter.
 *
 * @param {number} attempt — 1-based attempt number
 * @param {object} [opts]
 * @param {number} [opts.base=100] — base delay in ms
 * @param {number} [opts.factor=2] — exponential factor
 * @param {number} [opts.maxDelay=30000] — maximum delay in ms
 * @param {number} [opts.prevDelay=0] — previous delay (for decorrelated jitter)
 * @param {('none'|'full'|'equal'|'decorrelated')} [opts.jitter='full']
 * @returns {{delay:number, prevDelay:number}}
 */
export function computeDelay(attempt, opts = {}) {
  const {
    base = 100,
    factor = 2,
    maxDelay = 30000,
    prevDelay = 0,
    jitter = 'full',
  } = opts;

  if (attempt < 1) throw new RangeError('attempt must be >= 1');
  if (base < 0) throw new RangeError('base must be >= 0');
  if (factor < 1) throw new RangeError('factor must be >= 1');
  if (maxDelay < 0) throw new RangeError('maxDelay must be >= 0');

  let delay;
  let newPrev;

  if (jitter === 'decorrelated') {
    // Decorrelated jitter: delay = min(maxDelay, random(base, prevDelay * 3))
    const upper = prevDelay === 0 ? base : prevDelay * 3;
    delay = base + Math.random() * (upper - base);
    newPrev = delay;
  } else {
    const raw = Math.min(base * Math.pow(factor, attempt - 1), maxDelay);

    if (jitter === 'none') {
      delay = raw;
    } else if (jitter === 'equal') {
      delay = raw / 2 + Math.random() * (raw / 2);
    } else {
      // full
      delay = Math.random() * raw;
    }
    newPrev = raw;
  }

  delay = Math.min(delay, maxDelay);
  return { delay: Math.round(delay), prevDelay: newPrev };
}

/**
 * Sleep with optional AbortSignal support.
 * @private
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetryAbortError('Aborted before sleep'));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new RetryAbortError('Aborted during backoff'));
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort);
  });
}

/** Custom error for abort. */
export class RetryAbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetryAbortError';
  }
}

/** Custom error thrown when retries are exhausted. */
export class RetryExhaustedError extends Error {
  constructor(message, { attempts, lastError, results }) {
    super(message);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.lastError = lastError;
    this.results = results;
  }
}

/**
 * Retry an async function with exponential backoff.
 *
 * @param {function} fn — async function, receives attempt number (1-based)
 * @param {object} [opts]
 * @param {number} [opts.retries=3] — number of retries (total attempts = retries + 1)
 * @param {number} [opts.base=100] — base delay in ms
 * @param {number} [opts.factor=2] — backoff multiplier
 * @param {number} [opts.maxDelay=30000] — cap on computed delay
 * @param {('none'|'full'|'equal'|'decorrelated')} [opts.jitter='full']
 * @param {number} [opts.timeout=0] — per-attempt timeout in ms (0 = disabled)
 * @param {AbortSignal} [opts.signal] — abort signal
 * @param {function} [opts.onRetry] — called with (error, attempt, delay) before each retry
 * @param {function} [opts.shouldRetry] — predicate(err) => boolean; defaults to always retry
 * @returns {Promise<*>} — resolved value from fn
 */
export async function retry(fn, opts = {}) {
  const {
    retries = 3,
    base = 100,
    factor = 2,
    maxDelay = 30000,
    jitter = 'full',
    timeout = 0,
    signal,
    onRetry,
    shouldRetry,
  } = opts;

  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  if (retries < 0) throw new RangeError('retries must be >= 0');

  let prevDelay = 0;
  let lastError;
  const maxAttempts = retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new RetryAbortError('Aborted');

    try {
      let result;
      if (timeout > 0) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        // Wire external signal too
        const onExternalAbort = () => controller.abort();
        signal?.addEventListener('abort', onExternalAbort);

        try {
          result = await Promise.race([
            fn(attempt),
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => {
                reject(new Error(`Attempt ${attempt} timed out after ${timeout}ms`));
              });
            }),
          ]);
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onExternalAbort);
        }
      } else {
        result = await fn(attempt);
      }
      return result;
    } catch (err) {
      lastError = err;

      if (err instanceof RetryAbortError) throw err;

      const isLast = attempt >= maxAttempts;
      const allowed = shouldRetry ? shouldRetry(err) : true;

      if (isLast || !allowed) {
        throw new RetryExhaustedError(
          `Retry exhausted after ${attempt} attempt(s): ${err.message}`,
          { attempts: attempt, lastError: err, results: undefined }
        );
      }

      const { delay, prevDelay: newPrev } = computeDelay(attempt, {
        base, factor, maxDelay, jitter, prevDelay,
      });
      prevDelay = newPrev;

      if (onRetry) onRetry(err, attempt, delay);

      await sleep(delay, signal);
    }
  }

  // Should never reach here
  throw lastError;
}

/**
 * Create a retryable version of a function.
 *
 * @example
 * const fetchRetry = retryable(fetch, { retries: 5, base: 200 });
 * await fetchRetry('https://api.example.com/data');
 *
 * @param {function} fn
 * @param {object} opts — same as retry()
 * @returns {function} — function that auto-retries
 */
export function retryable(fn, opts = {}) {
  return (...args) => retry(() => fn(...args), opts);
}

/**
 * Build a retry schedule without executing.
 * Useful for debugging and visualization.
 *
 * @param {number} attempts — number of attempts to schedule
 * @param {object} [opts] — same computeDelay options
 * @returns {number[]} — array of delays in ms
 */
export function schedule(attempts, opts = {}) {
  if (attempts < 0) throw new RangeError('attempts must be >= 0');
  const delays = [];
  let prevDelay = 0;
  for (let a = 1; a <= attempts; a++) {
    const { delay, prevDelay: np } = computeDelay(a, { ...opts, prevDelay });
    prevDelay = np;
    delays.push(delay);
  }
  return delays;
}

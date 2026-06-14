# retryx

Zero-dependency retry with exponential backoff, jitter strategies, and retry predicates.

Because production code fails, and `try/catch` isn't a strategy.

## Why

Every project eventually needs retries — API calls, DB connections, file locks. Most implementations are copy-pasted Stack Overflow snippets with a `setTimeout` and a prayer. This does it properly:

- **4 jitter strategies** (none, full, equal, decorrelated) to prevent thundering herd
- **Retry predicates** — only retry on specific errors
- **Per-attempt timeouts** — kill hangs before they cascade
- **AbortSignal support** — cancel retries from anywhere
- **Zero dependencies** — nothing to audit, nothing to break

## Install

```bash
npm install retryx
```

## Quick Start

```js
import { retry } from 'retryx';

// Retry a flaky API call
const data = await retry(
  () => fetch('https://api.example.com/data').then(r => r.json()),
  { retries: 5, base: 200 }
);
```

## API

### `retry(fn, opts)`

Retry an async function with exponential backoff.

```js
const result = await retry(
  async (attempt) => {
    console.log(`Attempt ${attempt}...`);
    return doWork();
  },
  {
    retries: 3,           // max retries (total attempts = retries + 1)
    base: 100,            // base delay in ms
    factor: 2,            // exponential multiplier
    maxDelay: 30000,      // cap on delay
    jitter: 'full',       // 'none' | 'full' | 'equal' | 'decorrelated'
    timeout: 5000,        // per-attempt timeout (0 = disabled)
    signal: controller.signal,  // AbortSignal
    onRetry: (err, attempt, delay) => {
      console.log(`Attempt ${attempt} failed, retrying in ${delay}ms`);
    },
    shouldRetry: (err) => {
      // Only retry on network errors, not 4xx
      return err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
    },
  }
);
```

### `retryable(fn, opts)`

Create a pre-configured retry wrapper.

```js
import { retryable } from 'retryx';

const fetchRetry = retryable(fetch, { retries: 3, base: 200 });

// Use anywhere — retries are baked in
const res = await fetchRetry('https://api.example.com/data');
```

### `computeDelay(attempt, opts)`

Calculate the delay for a specific attempt. Useful for UIs that show retry countdowns.

```js
import { computeDelay } from 'retryx';

const { delay } = computeDelay(3, { base: 100, factor: 2 });
// delay = 0-400 (with full jitter)
```

### `schedule(attempts, opts)`

Generate the full retry schedule without executing anything.

```js
import { schedule } from 'retryx';

const delays = schedule(5, { base: 100, factor: 2, jitter: 'none' });
// [100, 200, 400, 800, 1600]
```

## Jitter Strategies

Jitter prevents synchronized retry storms when multiple clients fail simultaneously.

| Strategy | Formula | Spread |
|----------|---------|--------|
| `none` | `base * factor^(n-1)` | None — deterministic |
| `full` | `random(0, computed)` | Widest — best for load distribution |
| `equal` | `computed/2 + random(0, computed/2)` | Medium — tighter clustering |
| `decorrelated` | `random(base, prevDelay * 3)` | Adaptive — prevents synchronization |

**Recommendation:** Use `full` (default) for most cases. Use `decorrelated` for systems with many concurrent clients (AWS recommends this).

## Errors

- `RetryExhaustedError` — thrown when all retries are used up. Has `.attempts` and `.lastError`.
- `RetryAbortError` — thrown when an AbortSignal is triggered.

## CLI

```bash
# Not applicable — this is a library.
```

## License

MIT

import { test } from 'node:test';
import assert from 'node:assert';
import { retry, retryable, computeDelay, schedule, RetryExhaustedError, RetryAbortError } from './index.js';

test('computeDelay: exponential growth with jitter none', () => {
  const d1 = computeDelay(1, { base: 100, factor: 2, jitter: 'none' });
  const d2 = computeDelay(2, { base: 100, factor: 2, jitter: 'none' });
  const d3 = computeDelay(3, { base: 100, factor: 2, jitter: 'none' });
  assert.equal(d1.delay, 100);
  assert.equal(d2.delay, 200);
  assert.equal(d3.delay, 400);
});

test('computeDelay: maxDelay cap', () => {
  const d = computeDelay(10, { base: 100, factor: 2, maxDelay: 500, jitter: 'none' });
  assert.equal(d.delay, 500);
});

test('computeDelay: full jitter is within range', () => {
  for (let i = 0; i < 100; i++) {
    const { delay } = computeDelay(3, { base: 100, factor: 2, jitter: 'full' });
    assert.ok(delay >= 0 && delay <= 400, `delay ${delay} out of range`);
  }
});

test('computeDelay: equal jitter is within range', () => {
  for (let i = 0; i < 100; i++) {
    const { delay } = computeDelay(2, { base: 100, factor: 2, jitter: 'equal' });
    assert.ok(delay >= 100 && delay <= 200, `delay ${delay} out of range`);
  }
});

test('computeDelay: decorrelated jitter', () => {
  const { delay, prevDelay } = computeDelay(1, { base: 100, factor: 2, jitter: 'decorrelated' });
  assert.ok(delay >= 100, `first decorrelated should be >= base, got ${delay}`);
  assert.ok(prevDelay >= 100);
});

test('computeDelay: invalid attempt throws', () => {
  assert.throws(() => computeDelay(0), RangeError);
  assert.throws(() => computeDelay(-1), RangeError);
});

test('computeDelay: invalid base throws', () => {
  assert.throws(() => computeDelay(1, { base: -1 }), RangeError);
});

test('computeDelay: invalid factor throws', () => {
  assert.throws(() => computeDelay(1, { factor: 0.5 }), RangeError);
});

test('retry: succeeds on first attempt', async () => {
  let calls = 0;
  const result = await retry(async () => { calls++; return 'ok'; });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retry: succeeds after failures', async () => {
  let calls = 0;
  const result = await retry(async () => {
    calls++;
    if (calls < 3) throw new Error('fail');
    return 'ok';
  }, { retries: 5, base: 1, jitter: 'none' });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('retry: exhausts retries', async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => { calls++; throw new Error('always fail'); }, { retries: 2, base: 1 }),
    (err) => {
      assert.equal(err.name, 'RetryExhaustedError');
      assert.equal(err.attempts, 3);
      assert.equal(err.lastError.message, 'always fail');
      return true;
    }
  );
  assert.equal(calls, 3);
});

test('retry: shouldRetry predicate', async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => {
      calls++;
      throw new Error('skip');
    }, {
      retries: 10, base: 1,
      shouldRetry: () => false,
    }),
    (err) => {
      assert.equal(err.name, 'RetryExhaustedError');
      assert.equal(err.attempts, 1);
      return true;
    }
  );
  assert.equal(calls, 1);
});

test('retry: shouldRetry allows retry on certain errors', async () => {
  let calls = 0;
  const result = await retry(async () => {
    calls++;
    if (calls === 1) throw new TypeError('retry me');
    return 'ok';
  }, {
    retries: 3, base: 1,
    shouldRetry: (e) => e instanceof TypeError,
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('retry: onRetry callback fires with correct args', async () => {
  const calls = [];
  await retry(async (attempt) => {
    if (attempt < 3) throw new Error(`fail-${attempt}`);
    return 'ok';
  }, {
    retries: 5, base: 100, jitter: 'none',
    onRetry: (err, attempt, delay) => calls.push({ msg: err.message, attempt, delay }),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].attempt, 1);
  assert.equal(calls[0].msg, 'fail-1');
  assert.equal(calls[0].delay, 100);
  assert.equal(calls[1].attempt, 2);
  assert.equal(calls[1].delay, 200);
});

test('retry: zero retries', async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => { calls++; throw new Error('nope'); }, { retries: 0 }),
    RetryExhaustedError
  );
  assert.equal(calls, 1);
});

test('retry: fn receives attempt number', async () => {
  const attempts = [];
  await retry(async (attempt) => {
    attempts.push(attempt);
    if (attempt < 2) throw new Error('retry');
    return 'done';
  }, { retries: 3, base: 1 });
  assert.deepEqual(attempts, [1, 2]);
});

test('retry: AbortSignal cancels before start', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    retry(async () => 'ok', { signal: controller.signal }),
    RetryAbortError
  );
});

test('retry: AbortSignal cancels during backoff', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    retry(async () => { throw new Error('fail'); }, {
      retries: 10, base: 5000, jitter: 'none', signal: controller.signal,
    }),
    RetryAbortError
  );
});

test('retry: timeout per attempt', async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => {
      calls++;
      await new Promise(r => setTimeout(r, 200));
      return 'ok';
    }, { retries: 1, base: 1, timeout: 50 }),
    RetryExhaustedError
  );
  assert.equal(calls, 2);
});

test('retryable: creates retry wrapper', async () => {
  let calls = 0;
  const fn = retryable(async (x) => {
    calls++;
    if (calls < 2) throw new Error('fail');
    return x * 2;
  }, { retries: 3, base: 1 });

  const result = await fn(21);
  assert.equal(result, 42);
  assert.equal(calls, 2);
});

test('schedule: returns delay array', () => {
  const delays = schedule(4, { base: 100, factor: 2, maxDelay: 1000, jitter: 'none' });
  assert.equal(delays.length, 4);
  assert.deepEqual(delays, [100, 200, 400, 800]);
});

test('schedule: caps at maxDelay', () => {
  const delays = schedule(6, { base: 100, factor: 2, maxDelay: 500, jitter: 'none' });
  assert.deepEqual(delays, [100, 200, 400, 500, 500, 500]);
});

test('schedule: zero attempts', () => {
  assert.deepEqual(schedule(0), []);
});

test('schedule: full jitter produces valid range', () => {
  for (let i = 0; i < 50; i++) {
    const delays = schedule(3, { base: 100, factor: 2, jitter: 'full' });
    assert.ok(delays[0] >= 0 && delays[0] <= 100);
    assert.ok(delays[1] >= 0 && delays[1] <= 200);
    assert.ok(delays[2] >= 0 && delays[2] <= 400);
  }
});

test('retry: returns resolved value from later attempt', async () => {
  let calls = 0;
  const result = await retry(async () => {
    calls++;
    if (calls < 4) throw new Error('not yet');
    return { status: 'success', attempt: calls };
  }, { retries: 5, base: 1, jitter: 'none' });
  assert.equal(result.status, 'success');
  assert.equal(result.attempt, 4);
});

test('RetryExhaustedError has correct properties', () => {
  const err = new RetryExhaustedError('test', { attempts: 5, lastError: new Error('boom') });
  assert.equal(err.name, 'RetryExhaustedError');
  assert.equal(err.attempts, 5);
  assert.equal(err.lastError.message, 'boom');
  assert.ok(err instanceof Error);
});

test('retry: passes through non-Error rejections', async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => { calls++; throw 'string error'; }, { retries: 2, base: 1 }),
    RetryExhaustedError
  );
  assert.equal(calls, 3);
});

test('decorrelated jitter stays within bounds over multiple attempts', () => {
  let prevDelay = 0;
  for (let a = 1; a <= 10; a++) {
    const { delay, prevDelay: np } = computeDelay(a, {
      base: 100, factor: 3, maxDelay: 5000, jitter: 'decorrelated', prevDelay,
    });
    assert.ok(delay >= 100, `attempt ${a}: delay ${delay} < base`);
    assert.ok(delay <= 5000, `attempt ${a}: delay ${delay} > maxDelay`);
    prevDelay = np;
  }
});

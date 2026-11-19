// The entry <-> env lifecycle. The suite scores the server app.ts builds; this file is only the
// contract that keeps that server alive for the whole trial and tells the env where to dial it.
//
//   1. MAKEFUN_ENV_URL names the env's origin (http://store:8080 in a trial container). Without it
//      there is nothing to talk to, so the program exits 1 at once.
//   2. Create the server and listen(0): the kernel picks a free port. Never bind 8080 — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the address the request came from
//      plus N as the base URL and dials it from then on. The first register wins, and a 409 says one
//      already has: that is not this process's to fix, so it reports and keeps waiting like any other.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers at once
//      ({"done": false} while the suite runs), so this is a poll, not a long-held request. A failed or
//      slow poll is retried with a short exponential backoff; the process never exits before the env
//      says done, because an early exit takes the server away from checks still to come.
//   5. Close the server and exit 0. The harness then stops the env, which writes the export the
//      scorer reads.

import { createApp } from './app.ts';

/** The env's origin, without a trailing slash. */
const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** How long one register or done request may take before it is abandoned and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The first wait between retries, and the longest. */
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from RETRY_INITIAL_MS, capped. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer. A 409 means a first
 * register already won: retrying cannot help, so it is reported once and the caller carries on to
 * the done poll. 400 and 405 are contract errors and end the program, because the port never landed;
 * a network error or any other status is retried, since the env may still be starting.
 */
async function register(port: number): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200) return true;
      if (res.status === 409) {
        process.stderr.write('[entry] another entry registered first; waiting for the env anyway\n');
        return false;
      }
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done":true}; never return before that. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Close the listener and leave: 0 when the env said done, 1 when the trial was cut short. */
function leave(server: ReturnType<typeof createApp>, code: number): void {
  // An idle keep-alive socket would otherwise hold the process open past the harness's patience.
  server.close(() => process.exit(code));
  server.closeIdleConnections();
  setTimeout(() => process.exit(code), 5_000).unref();
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  // A trial stopped early is stopped with a signal, not a request. Report it and leave with a
  // non-zero status: this run did not reach the env's own "done".
  const stop = (signal: string): void => {
    process.stderr.write(`[entry] ${signal} received before the env said done\n`);
    leave(server, 1);
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  const registered = await register(address.port);
  process.stdout.write(registered ? '[entry] registered; waiting for the env to say done\n' : '[entry] waiting for the env to say done\n');

  await waitForDone();
  process.stdout.write('[entry] done\n');
  leave(server, 0);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

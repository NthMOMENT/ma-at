// Gate test (RPC key rotation): verifies rpc_rotation.ts's cooldown/rotation
// logic — a mocked 429 marks a URL cooling down and the next call skips it
// (silently, no repeat log), and after RPC_COOLDOWN_SEC the URL is tried
// again. No network calls except through a monkey-patched global.fetch, so
// this runs standalone. No test runner (jest/vitest) is wired up in this
// package yet — plain assertion script, matching this repo's other
// *.gate.test.ts files. Run with:
//
//   npx ts-node src/rpc_rotation.gate.test.ts
import { rotationOrder, recordCapacityError, isCapacityError, createRotatingHttpTransport, _resetHealthForTests } from "./rpc_rotation";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    console.error(`  FAIL ${name}`);
    failures++;
  }
}

async function main(): Promise<void> {

console.log("[gate-test] 1) isCapacityError matches 429/capacity/rate-limit shapes, not arbitrary errors");
{
  check("HTTP 429 message", isCapacityError(new Error("HTTP 429 from RPC endpoint")));
  check("monthly capacity message", isCapacityError(new Error("Your app has exceeded its monthly capacity limit")));
  check("rate limit message", isCapacityError(new Error("rate limit exceeded, please slow down")));
  check("plain timeout is NOT a capacity error", !isCapacityError(new Error("connection timed out")));
}

console.log("[gate-test] 2) rotationOrder starts at startIndex and wraps round-robin when nothing is cooling down");
{
  _resetHealthForTests();
  const urls = ["u0", "u1", "u2"];
  check("start at 0", JSON.stringify(rotationOrder(urls, 0, 1000)) === JSON.stringify([0, 1, 2]));
  check("start at 1 wraps", JSON.stringify(rotationOrder(urls, 1, 1000)) === JSON.stringify([1, 2, 0]));
}

console.log("[gate-test] 3) a capacity error marks the URL cooling down and the next call's rotationOrder skips it");
{
  _resetHealthForTests();
  const urls = ["u0", "u1", "u2"];
  let warnCount = 0;
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnCount++; origWarn(...(args as [])); };

  recordCapacityError(urls[0], 1000, 1800, "test URL_1");
  check("cooldown-start logs exactly once", warnCount === 1);

  const order = rotationOrder(urls, 0, 1500); // still within the 1800s cooldown
  check("cooling-down URL is skipped", !order.includes(0));
  check("the other two URLs are still tried", order.includes(1) && order.includes(2));

  // A second call while STILL cooling down must not log again — this is the
  // "avoid spamming a monthly-limit line every 4 seconds" requirement.
  rotationOrder(urls, 0, 1600);
  check("skipping again does NOT log a second time", warnCount === 1);

  console.warn = origWarn;
}

console.log("[gate-test] 4) after COOLDOWN_SEC elapses (mocked clock), the URL is tried again");
{
  _resetHealthForTests();
  const urls = ["u0", "u1", "u2"];
  // nowMs=1000, cooldownSec=1800 -> coolDownUntilMs = 1000 + 1800*1000 = 1_801_000
  recordCapacityError(urls[0], 1000, 1800, "test URL_1");

  const stillCooling = rotationOrder(urls, 0, 1_800_999);
  check("still cooling 1ms before expiry", !stillCooling.includes(0));

  const expired = rotationOrder(urls, 0, 1_801_000);
  check("tried again once the cooldown has elapsed", expired.includes(0));
}

console.log("[gate-test] 5) every URL cooling down falls back to trying all of them anyway (fail open), least-recently-cooled first");
{
  _resetHealthForTests();
  const urls = ["u0", "u1", "u2"];
  // u1 cooled down first (at nowMs=500 -> expires 500+1800*1000), u0 second
  // (nowMs=1000 -> expires later), u2 last (nowMs=1500 -> expires latest).
  // u1 should therefore be tried FIRST once every URL is cooling — it's the
  // one closest to actually recovering.
  recordCapacityError(urls[1], 500, 1800, "test URL_2");
  recordCapacityError(urls[0], 1000, 1800, "test URL_1");
  recordCapacityError(urls[2], 1500, 1800, "test URL_3");
  const order = rotationOrder(urls, 0, 1600);
  check("all 3 still attempted despite all cooling down", order.length === 3);
  check("least-recently-cooled (u1) is tried first", order[0] === 1);
  check("then u0 (cooled second)", order[1] === 0);
  check("then u2 (cooled last)", order[2] === 2);
}

console.log("[gate-test] 6) createRotatingHttpTransport: a mocked 429 on URL_1 makes the transport fall through to URL_2, then skip URL_1 on the very next call without retrying it");
{
  _resetHealthForTests();
  const urls = ["http://rpc-1.invalid/v2/fakekey1", "http://rpc-2.invalid/v2/fakekey2"];
  let calls: string[] = [];
  const origFetch = global.fetch;
  // @ts-expect-error - test stub, narrower than the real fetch signature
  global.fetch = async (url: string) => {
    calls.push(url);
    if (url === urls[0]) {
      return { ok: false, status: 429, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ result: "0x1" }) } as Response;
  };

  const transport = createRotatingHttpTransport(urls, "test-transport");
  // viem's CustomTransport is a factory function; invoke it directly like viem's client internals do.
  const built = transport({ retryCount: 0 } as never);

  calls = [];
  const result1 = await built.request({ method: "eth_blockNumber", params: [] });
  check("first call falls through URL_1 -> URL_2 and returns URL_2's result", result1 === "0x1");
  check("first call actually attempted both URLs", calls.length === 2 && calls[0] === urls[0] && calls[1] === urls[1]);

  calls = [];
  const result2 = await built.request({ method: "eth_blockNumber", params: [] });
  check("second call skips the still-cooling URL_1 entirely", calls.length === 1 && calls[0] === urls[1]);
  check("second call still succeeds via URL_2", result2 === "0x1");

  global.fetch = origFetch;
}

console.log("[gate-test] 7) createRotatingHttpTransport: a transient (non-capacity) failure on every URL in one sweep is retried at the outer-sweep level and eventually succeeds");
{
  _resetHealthForTests();
  const urls = ["http://rpc-1.invalid/v2/fakekey1", "http://rpc-2.invalid/v2/fakekey2"];
  let attemptNumber = 0;
  const origFetch = global.fetch;
  // Both URLs fail with a plain transient error on the first sweep; the
  // second sweep (this transport's outer-sweep retry) succeeds. Neither
  // failure is capacity-shaped, so neither URL should ever be marked
  // cooling down.
  global.fetch = async () => {
    attemptNumber++;
    if (attemptNumber <= 2) {
      throw new Error("network error: connection reset");
    }
    return { ok: true, status: 200, json: async () => ({ result: "0x2" }) } as Response;
  };

  const transport = createRotatingHttpTransport(urls, "test-transport-retry");
  const built = transport({ retryCount: 0 } as never);
  const result = await built.request({ method: "eth_blockNumber", params: [] });
  check("outer-sweep retry eventually returns the successful result", result === "0x2");
  check("neither URL was marked cooling down (non-capacity error)", rotationOrder(urls, 0, Date.now()).length === 2);

  global.fetch = origFetch;
}

console.log("[gate-test] 8) createRotatingHttpTransport: a genuinely dead endpoint (every sweep fails) still throws a real error to the caller, not a hang or a swallowed failure");
{
  _resetHealthForTests();
  const urls = ["http://rpc-1.invalid/v2/fakekey1"];
  const origFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("network error: connection reset");
  };

  const transport = createRotatingHttpTransport(urls, "test-transport-dead");
  const built = transport({ retryCount: 0 } as never);
  let threw = false;
  let message = "";
  try {
    await built.request({ method: "eth_blockNumber", params: [] });
  } catch (err) {
    threw = true;
    message = (err as Error).message ?? String(err);
  }
  check("caller receives a real thrown error, not a hang or a silent undefined", threw);
  check("the error message is the real underlying failure, not swallowed", message.includes("connection reset"));

  global.fetch = origFetch;
}

}

main().then(() => {
  if (failures > 0) {
    console.error(`\n[gate-test] ${failures} check(s) FAILED`);
    process.exit(1);
  } else {
    console.log(`\n[gate-test] all checks passed`);
  }
});

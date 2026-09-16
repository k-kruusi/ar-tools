// Test fixture: loaded via NODE_OPTIONS=--import into the same process that runs
// stdio.ts, so it shares that process's global handlers. After a delay (long
// enough for stdio.ts to register its crash guards and set ready=true) it fires
// a genuine unhandledRejection and a genuine uncaughtException. If stdio.ts's
// guards work, the process logs to stderr and STAYS ALIVE; if they're missing or
// call exit(), the process dies and the test's follow-up tools/list fails.
const delay = Number(process.env.FAULT_DELAY_MS || "2500");

setTimeout(() => {
  // unhandledRejection — a fire-and-forget promise with no catch.
  Promise.reject(new Error("injected-unhandled-rejection"));
}, delay);

setTimeout(() => {
  // uncaughtException — thrown from a timer callback, escapes all try/catch.
  throw new Error("injected-uncaught-exception");
}, delay + 300);

// In-memory, single-instance — same honest tradeoff as presence.store.ts.
// Once this runs across multiple instances, call scheduling needs to move
// to a shared job queue (BullMQ, per tech-stack/TECH_STACK.md §5) so
// whichever instance handles a given call's tick isn't tied to which
// instance happened to accept it.
const billingIntervals = new Map<string, NodeJS.Timeout>();
const ringingTimeouts = new Map<string, NodeJS.Timeout>();
const ticksInProgress = new Set<string>();

export function startBillingInterval(callId: string, onTick: () => void, intervalMs: number): void {
  stopBillingInterval(callId);
  // .unref() so a live call never blocks process shutdown by itself — the
  // HTTP server's listening socket is what keeps a real server alive, not
  // this timer, so this has no effect on production behavior. It does
  // matter for tests/scripts: without it, one leftover ringing/ongoing
  // call would hang the process on exit.
  billingIntervals.set(callId, setInterval(onTick, intervalMs).unref());
}

export function stopBillingInterval(callId: string): void {
  const handle = billingIntervals.get(callId);
  if (handle) {
    clearInterval(handle);
    billingIntervals.delete(callId);
  }
}

export function scheduleRingingTimeout(callId: string, onTimeout: () => void, timeoutMs: number): void {
  clearRingingTimeout(callId);
  ringingTimeouts.set(callId, setTimeout(onTimeout, timeoutMs).unref());
}

export function clearRingingTimeout(callId: string): void {
  const handle = ringingTimeouts.get(callId);
  if (handle) {
    clearTimeout(handle);
    ringingTimeouts.delete(callId);
  }
}

// True + marks in-progress if no tick for this call is currently running;
// false if one already is, so the caller can skip this cycle instead of
// racing it.
export function tryStartTick(callId: string): boolean {
  if (ticksInProgress.has(callId)) return false;
  ticksInProgress.add(callId);
  return true;
}

export function clearTickInProgress(callId: string): void {
  ticksInProgress.delete(callId);
}

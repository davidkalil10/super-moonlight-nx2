// Predicts the renderer's vsync so a staggered gate waiting for a publication to be
// applied sleeps off the bridge instead of polling the status. The phase is learned
// from status reads: a read that finds the publication applied right after one that
// did not brackets a vsync. While reads keep succeeding on the first try the phase is
// pulled earlier by driftMs, so a late estimate does not add latency for long.
// windowMs must cover marginMs plus one status read, or a slightly early estimate
// sleeps a whole frame (request-budget.cjs staggeredHostWait).
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function create({
  periodMs = 1000 / 60,
  marginMs = 1,
  pollMs = 2,
  windowMs = 5,
  driftMs = 0.1,
  now = Date.now,
  sleep = delay
} = {}) {
  let phase = null;
  let missed = false;
  let predicted = false;

  const nextVsync = at => phase + Math.ceil((at - phase) / periodMs) * periodMs;
  const sleepUntil = async at => {
    const ms = at - now();
    if (ms > 0) await sleep(ms);
  };

  return {
    // Before the first status read of a gate: wait for the vsync that applies a
    // publication whose fetch the host opened at openedAt.
    async beforeRead(openedAt) {
      missed = false;
      predicted = false;
      if (phase === null || openedAt === null || openedAt === undefined) return;
      const due = nextVsync(openedAt) + marginMs;
      if (due <= now()) return;
      predicted = true;
      await sleepUntil(due);
    },

    // After each read that checked the publication, with the time the read started.
    observe(startedAt, applied) {
      if (!applied) {
        missed = true;
        return;
      }
      if (missed) phase = startedAt;
      else if (predicted) phase -= driftMs;
      missed = false;
      predicted = false;
    },

    // A read found the publication not applied yet. Just after a predicted vsync the
    // estimate is probably a little early, so poll shortly; otherwise sleep to the next.
    async pending() {
      const at = now();
      if (phase === null) return sleep(pollMs);
      if (at - (nextVsync(at) - periodMs) < windowMs) return sleep(pollMs);
      await sleepUntil(nextVsync(at) + marginMs);
    },

    get phase() {
      return phase;
    }
  };
}

module.exports = {create};

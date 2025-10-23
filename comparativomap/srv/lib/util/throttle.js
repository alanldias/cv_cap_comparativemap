// util/throttle.js
function createSemaphore(limit = Infinity) {
  let inFlight = 0;
  const queue = [];
  async function acquire() {
    if (!Number.isFinite(limit) || limit <= 0) return; // sem limite
    if (inFlight < limit) { inFlight++; return; }
    await new Promise(res => queue.push(res));
    inFlight++;
  }
  function release() {
    if (!Number.isFinite(limit) || limit <= 0) return;
    inFlight--;
    const next = queue.shift();
    if (next) next();
  }
  async function run(fn) { await acquire(); try { return await fn(); } finally { release(); } }
  const stats = () => ({ limit, inFlight, queued: queue.length });
  return { run, stats };
}
module.exports = { createSemaphore };

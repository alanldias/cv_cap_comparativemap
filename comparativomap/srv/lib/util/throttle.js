// util/throttle.js
function createSemaphore(limit = Infinity) {
  let inFlight = 0; // execuções em voo
  const queue = []; // fila FIFO

  async function acquire() {
    if (!Number.isFinite(limit) || limit <= 0) return; // sem limite efetivo
    if (inFlight < limit) { inFlight++; return; } // entrou direto
    await new Promise(res => queue.push(res)); // espera vaga
    inFlight++;
  }

  function release() {
    if (!Number.isFinite(limit) || limit <= 0) return; // sem limite efetivo
    inFlight--; // libera 1 slot
    const next = queue.shift(); // acorda próximo
    if (next) next();
  }

  async function run(fn) { // wrapper que garante release no finally
    await acquire();
    try { return await fn(); } finally { release(); }
  }

  const stats = () => ({ limit, inFlight, queued: queue.length }); // métricas p/ log
  return { run, stats };
}
module.exports = { createSemaphore };

async function mapWithConcurrency(arr, limit, mapper) { // map async com limite de concorrência e preserva ordem
  const results = new Array(arr.length); // saída alinhada ao índice original
  let i = 0; // cursor compartilhado entre workers
  const workers = Math.min(limit, arr.length); // nº de workers em paralelo

  async function worker() { // cada worker consome índices até acabar
    while (i < arr.length) {
      const idx = i++; // pega próximo índice (fila simples)
      try { results[idx] = await mapper(arr[idx], idx); } // aplica mapper
      catch (err) { results[idx] = { error: true, message: err?.message || String(err) }; } // normaliza erro
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker())); // executa workers
  return results; // mantém mesma ordem do input
}
module.exports = { mapWithConcurrency };

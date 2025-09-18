async function mapWithConcurrency(arr, limit, mapper) {
  const results = new Array(arr.length);
  let i = 0;
  const workers = Math.min(limit, arr.length);
  async function worker() {
    while (i < arr.length) {
      const idx = i++;
      try {
        results[idx] = await mapper(arr[idx], idx);
      } catch (err) {
        results[idx] = { error: true, message: err?.message || String(err) };
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
module.exports = { mapWithConcurrency };

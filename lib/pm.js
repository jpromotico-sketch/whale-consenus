export const DATA = 'https://data-api.polymarket.com';
export const GAMMA = 'https://gamma-api.polymarket.com';

// GET json, retrying politely on 429/503 (Polymarket sends Retry-After).
export async function getJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status === 503) && i < tries - 1) {
      const wait = Math.min(Number(r.headers.get('retry-after')) || 1, 4);
      await new Promise((s) => setTimeout(s, wait * 1000));
      continue;
    }
    throw new Error(`${r.status} from ${new URL(url).pathname}`);
  }
}

// Run fn over items with limited concurrency, keeping order.
export async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    })
  );
  return out;
}

// A wallet "chose" the outcome holding >=65% of its stake in a market;
// anything closer is treated as hedged and not counted for either side.
export function stance(sides) {
  const e = Object.entries(sides).sort((a, b) => b[1] - a[1]);
  const total = e.reduce((s, x) => s + x[1], 0);
  const [outcome, stake] = e[0];
  return { outcome, stake: Math.round(stake), split: e.length > 1 && stake < 0.65 * total };
}

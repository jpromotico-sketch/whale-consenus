// For one event, reports which side each tracked wallet holds in every market.
import { DATA, GAMMA, getJson, pool, stance } from '../lib/pm.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;

function slugOf(s) {
  s = String(s).trim();
  try {
    const p = new URL(s).pathname.split('/').filter(Boolean);
    const i = p.indexOf('event');
    return i >= 0 ? p[i + 1] : p[p.length - 1];
  } catch {
    return s;
  }
}

const parse = (s) => { try { return JSON.parse(s); } catch { return []; } };

// Polymarket's type label for spreads isn't confirmed in the docs, so also match the title.
const isSpread = (m) => /^spreads?$/i.test(m.sportsMarketType || '') || /^spread\b/i.test(m.question || '');

// Market-wide money on the game's main markets: everyone, not just tracked wallets.
// "value" = shares held by the top 500 holders of each side, at the current price.
async function money(ev) {
  let mks = (ev.markets || []).filter((m) => m.sportsMarketType === 'moneyline');
  if (!mks.length) mks = (ev.markets || []).slice(0, 3);
  mks = mks.slice(0, 3);
  if (!mks.length) return [];
  const ids = mks.map((m) => m.conditionId).join(',');
  const [h, oi] = await Promise.all([
    getJson(`${DATA}/v2/holders?condition=${ids}&limit=500`),
    getJson(`${DATA}/v2/oi?condition=${ids}`),
  ]);
  const oiBy = Object.fromEntries(oi.data.map((r) => [r.condition_id.toLowerCase(), r.value]));
  const byToken = Object.fromEntries(h.data.map((g) => [g.token_id, g.holders]));
  return mks.map((m) => {
    const names = parse(m.outcomes), prices = parse(m.outcomePrices).map(Number), toks = parse(m.clobTokenIds);
    return {
      question: m.question,
      volume: Math.round(Number(m.volumeNum) || 0),
      volume24h: Math.round(Number(m.volume24hr) || 0),
      openInterest: Math.round(oiBy[m.conditionId.toLowerCase()] || 0),
      sides: names.map((name, i) => {
        const hs = byToken[toks[i]] || [];
        const shares = hs.reduce((s, x) => s + x.amount, 0);
        return { name, price: prices[i], holders: hs.length, value: Math.round(shares * prices[i]) };
      }),
    };
  });
}

export default async function handler(req, res) {
  try {
    const slug = slugOf(req.query.event || '');
    const wallets = String(req.query.wallets || '')
      .split(',')
      .filter((w) => ADDR.test(w))
      .map((w) => w.toLowerCase())
      .slice(0, 50);
    if (!slug || !wallets.length) return res.status(400).json({ error: 'Need an event and wallets.' });

    const ev = await getJson(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`);
    const markets = new Map(
      (ev.markets || []).map((m) => [
        m.conditionId.toLowerCase(),
        { question: m.question, type: m.sportsMarketType || '' },
      ])
    );

    const [perWallet, moneyData] = await Promise.all([pool(wallets, 6, async (w) => {
      const r = await getJson(`${DATA}/v2/positions?user=${w}&event_id=${ev.id}&limit=500`);
      return { w, rows: r.data };
    }), money(ev).catch(() => [])]);

    // stake = what the wallet paid for the shares it still holds
    const stakes = {};
    for (const { w, rows } of perWallet)
      for (const p of rows) {
        const c = p.condition_id.toLowerCase();
        if (!markets.has(c)) continue;
        const s = ((stakes[c] ??= {})[w] ??= {});
        s[p.outcome] = (s[p.outcome] || 0) + p.current_size * p.avg_price;
      }

    const spreadMarkets = (ev.markets || []).filter((m) => isSpread(m) && !m.closed);
    const spreadIds = new Set(spreadMarkets.map((m) => m.conditionId.toLowerCase()));
    const spreads = spreadMarkets
      .map((m) => {
        const names = parse(m.outcomes), prices = parse(m.outcomePrices).map(Number);
        const st = Object.values(stakes[m.conditionId.toLowerCase()] || {}).map(stance);
        return {
          question: m.question,
          line: m.line ?? null,
          volume: Math.round(Number(m.volumeNum) || 0),
          sides: names.map((name, i) => {
            const mine = st.filter((s) => !s.split && s.outcome === name);
            return { name, price: prices[i], whales: mine.length, stake: mine.reduce((a, s) => a + s.stake, 0) };
          }),
        };
      })
      .sort((a, b) => Math.abs(a.line ?? 0) - Math.abs(b.line ?? 0))
      .slice(0, 20);

    const list = Object.entries(stakes).filter(([c]) => !spreadIds.has(c)).map(([c, ws]) => ({
      conditionId: c,
      ...markets.get(c),
      stances: Object.entries(ws).map(([wallet, sides]) => ({ wallet, ...stance(sides) })),
    }));
    list.sort(
      (a, b) => (b.type === 'moneyline') - (a.type === 'moneyline') || b.stances.length - a.stances.length
    );

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json({
      event: { title: ev.title, slug },
      checked: wallets.length,
      money: moneyData,
      spreads,
      markets: list.slice(0, 15),
    });
  } catch (e) {
    res.status(/^404/.test(e.message) ? 404 : 502).json({
      error: /^404/.test(e.message) ? 'Event not found. Paste the full polymarket.com/event/... link.' : e.message,
    });
  }
}

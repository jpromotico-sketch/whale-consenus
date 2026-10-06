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

    const perWallet = await pool(wallets, 6, async (w) => {
      const r = await getJson(`${DATA}/v2/positions?user=${w}&event_id=${ev.id}&limit=500`);
      return { w, rows: r.data };
    });

    // stake = what the wallet paid for the shares it still holds
    const stakes = {};
    for (const { w, rows } of perWallet)
      for (const p of rows) {
        const c = p.condition_id.toLowerCase();
        if (!markets.has(c)) continue;
        const s = ((stakes[c] ??= {})[w] ??= {});
        s[p.outcome] = (s[p.outcome] || 0) + p.current_size * p.avg_price;
      }

    const list = Object.entries(stakes).map(([c, ws]) => ({
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
      markets: list.slice(0, 15),
    });
  } catch (e) {
    res.status(/^404/.test(e.message) ? 404 : 502).json({
      error: /^404/.test(e.message) ? 'Event not found. Paste the full polymarket.com/event/... link.' : e.message,
    });
  }
}

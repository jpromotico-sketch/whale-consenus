// Finds games for you: pulls each whale's open positions once, groups them by
// event, and returns upcoming/live games where the whales agree on a moneyline side.
import { DATA, GAMMA, getJson, pool, stance } from '../lib/pm.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const MIN_WHALES = Number(process.env.MIN_WHALES || 5); // wallets that took a side
const MIN_AGREE = Number(process.env.MIN_AGREE || 0.7); // share of side-takers on the lead outcome
const DAYS = Number(process.env.HORIZON_DAYS || 2); // how far ahead to look

export default async function handler(req, res) {
  try {
    const wallets = String(req.query.wallets || '')
      .split(',').filter((w) => ADDR.test(w)).map((w) => w.toLowerCase()).slice(0, 50);
    if (!wallets.length) return res.status(400).json({ error: 'Need wallets.' });

    // 1. one call per wallet: its largest open positions across all of Polymarket
    const books = await pool(wallets, 6, async (w) => ({
      w,
      rows: (await getJson(`${DATA}/v2/positions?user=${w}&limit=300`)).data,
    }));

    // 2. event -> market -> { stakes: wallet -> outcome -> stake, price: outcome -> price }
    const events = {};
    for (const { w, rows } of books)
      for (const p of rows) {
        if (p.redeemable) continue; // already settled
        const m = ((events[p.event_id] ??= {})[p.condition_id.toLowerCase()] ??= { stakes: {}, price: {} });
        const s = (m.stakes[w] ??= {});
        s[p.outcome] = (s[p.outcome] || 0) + p.current_size * p.avg_price;
        m.price[p.outcome] = p.current_price;
      }

    // 3. keep events with enough whales, then ask Gamma which are real upcoming games
    const busy = (id) => Math.max(...Object.values(events[id]).map((m) => Object.keys(m.stakes).length));
    const ids = Object.keys(events).filter((id) => busy(id) >= MIN_WHALES).sort((a, b) => busy(b) - busy(a)).slice(0, 40);
    const chunks = [];
    for (let i = 0; i < ids.length; i += 20) chunks.push(ids.slice(i, i + 20));
    const meta = (await pool(chunks, 2, (c) =>
      getJson(`${GAMMA}/events?${c.map((i) => 'id=' + i).join('&')}&limit=20`)
    )).flat();

    const now = Date.now();
    const picks = [];
    for (const e of meta) {
      const start = e.startTime ? Date.parse(e.startTime) : null;
      if (e.ended || e.closed || (start && start > now + DAYS * 864e5)) continue;
      let best = null;
      for (const mk of e.markets || []) {
        const m = events[e.id]?.[mk.conditionId.toLowerCase()];
        if (mk.sportsMarketType !== 'moneyline' || !m) continue;
        const st = Object.entries(m.stakes).map(([wallet, sides]) => stance(sides));
        const c = {};
        let hedged = 0;
        for (const s of st) s.split ? hedged++ : (c[s.outcome] = (c[s.outcome] || 0) + 1);
        const [outcome, count] = Object.entries(c).sort((a, b) => b[1] - a[1])[0] || [];
        if (!outcome) continue;
        const against = Object.values(c).reduce((a, b) => a + b, 0) - count;
        const cand = { question: mk.question, outcome, count, against, hedged, price: m.price[outcome] };
        if (!best || count > best.count) best = cand;
      }
      if (!best || best.count + best.against < MIN_WHALES || best.count / (best.count + best.against) < MIN_AGREE) continue;
      picks.push({ title: e.title, slug: e.slug, start: e.startTime || null, live: !!e.live || (!!start && start < now), ...best });
    }
    picks.sort((a, b) => b.count / (b.count + b.against) - a.count / (a.count + a.against) || b.count - a.count);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ checked: wallets.length, picks: picks.slice(0, 20) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}

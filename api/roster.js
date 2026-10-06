// Builds the whale list from Polymarket's SPORTS leaderboard only:
// the top sports wallets by all-time profit, kept only if they traded sports
// recently, then ranked by profit per share traded (the sports board reports
// volume in shares, not USD). Cached at the CDN for 12h.
import { DATA, getJson } from '../lib/pm.js';

const POOL = Number(process.env.POOL_SIZE || 150); // candidates by all-time sports profit
const SIZE = Number(process.env.ROSTER_SIZE || 30);
const MIN_SHARES = Number(process.env.MIN_VOLUME_SHARES || 100000);
const ACTIVE = process.env.ACTIVE_WINDOW || 'month'; // must have traded sports in this window: day | week | month

const board = (period, sort, limit) =>
  getJson(`${DATA}/v2/leaderboard?time_period=${period}&category=sports&sort_by=${sort}&limit=${limit}`).then((r) => r.data);

export default async function handler(req, res) {
  try {
    const [top, recent] = await Promise.all([board('all', 'PNL', POOL), board(ACTIVE, 'VOLUME', 1000)]);
    const active = new Set(recent.filter((r) => r.volume > 0).map((r) => r.user_id.toLowerCase()));
    const roster = top
      .filter((w) => active.has(w.user_id.toLowerCase()) && w.volume >= MIN_SHARES)
      .map((w) => ({
        wallet: w.user_id.toLowerCase(),
        name: w.user_name || w.user_id.slice(0, 8),
        pnl: w.pnl,
        volume: w.volume,
        roi: w.pnl / w.volume,
      }))
      .sort((a, b) => b.roi - a.roi)
      .slice(0, SIZE);
    if (!roster.length) throw new Error('No recently active sports wallets found. Try raising POOL_SIZE.');
    res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=86400');
    res.status(200).json({ updated: new Date().toISOString(), roster, candidates: top.length, active: active.size });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}

// Builds the "whale" list: of the top wallets by all-time profit, the 30 with the
// best profit % (profit / USD volume traded). Polymarket's API has no ROI field,
// so this is computed here. Cached at the CDN for 12h.
import { DATA, getJson, pool } from '../lib/pm.js';

const POOL = Number(process.env.POOL_SIZE || 100); // candidates, ranked by all-time PnL
const SIZE = Number(process.env.ROSTER_SIZE || 30);
const MIN_VOLUME = Number(process.env.MIN_VOLUME_USDC || 50000);

export default async function handler(req, res) {
  try {
    const board = await getJson(
      `${DATA}/v2/leaderboard?time_period=all&category=overall&sort_by=PNL&limit=${POOL}`
    );
    const rows = await pool(board.data, 8, async (w) => {
      const v = await getJson(`${DATA}/v2/user-volume?user=${w.user_id}`);
      const volume = v.data.volume_usdc;
      return {
        wallet: w.user_id.toLowerCase(),
        name: w.user_name || w.user_id.slice(0, 8),
        pnl: w.pnl,
        volume,
        roi: volume > 0 ? w.pnl / volume : null,
      };
    });
    const roster = rows
      .filter((r) => r.roi !== null && r.volume >= MIN_VOLUME)
      .sort((a, b) => b.roi - a.roi)
      .slice(0, SIZE);
    res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=86400');
    res.status(200).json({ updated: new Date().toISOString(), roster });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}

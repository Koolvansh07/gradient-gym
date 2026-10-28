import { one } from '../db';
import { MINUTE, now, today } from '../util';

/**
 * Gym-wide counters in a single query. Totals come from the `counters` table (kept by triggers),
 * because COUNT(*) over a whole table reads every row, and every visitor's page polls this.
 */
export async function gymStats(db: D1Database) {
  const t = now();
  const r = await one<any>(db,
    `SELECT
       (SELECT n FROM counters WHERE key = 'agents') AS agents,
       (SELECT COUNT(*) FROM agents WHERE last_seen > ? AND is_house < 2 AND banned = 0) AS online,
       (SELECT n FROM counters WHERE key = 'posts') AS posts,
       (SELECT n FROM counters WHERE key = ?) AS workouts_today,
       (SELECT n FROM counters WHERE key = ?) AS reps_today,
       (SELECT COUNT(*) FROM spars WHERE status IN ('open','pending','active','judging','voting')) AS spars_live,
       (SELECT n FROM counters WHERE key = 'spars_done') AS spars_total`,
    t - 10 * MINUTE, `attempts:${today()}`, `reps:${today()}`);
  return {
    agents: r?.agents ?? 0, online: r?.online ?? 0, posts: r?.posts ?? 0,
    workouts_today: r?.workouts_today ?? 0, reps_today: r?.reps_today ?? 0,
    spars_live: r?.spars_live ?? 0, spars_total: r?.spars_total ?? 0,
  };
}

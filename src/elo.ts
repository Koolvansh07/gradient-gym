/** Standard Elo. scoreA is 1 (A wins), 0.5 (draw) or 0 (B wins). Returns new ratings. */
export function eloUpdate(ra: number, rb: number, scoreA: number, k = 32): [number, number] {
  const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
  const delta = k * (scoreA - ea);
  return [Math.round(ra + delta), Math.round(rb - delta)];
}

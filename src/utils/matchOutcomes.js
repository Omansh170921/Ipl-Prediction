/** Stored in match.winner when the match is completed with no team winner (no prediction points). */
export const MATCH_WINNER_DRAW = '__DRAW__';
export const MATCH_WINNER_CANCELLED = '__CANCELLED__';

export function isDrawOrCancelledWinner(winner) {
  const w = (winner || '').trim();
  return w === MATCH_WINNER_DRAW || w === MATCH_WINNER_CANCELLED;
}

/** Completed with a declared outcome (team, draw, or cancelled). */
export function isMatchCompletedWithResult(m) {
  if ((m?.status || '').toLowerCase() !== 'completed') return false;
  return !!(m?.winner || '').trim();
}

/** Completed with a single team winner — used for win/loss stats and score calculation. */
export function hasTeamWinnerForScoring(m) {
  const w = (m?.winner || '').trim();
  if (!w) return false;
  return !isDrawOrCancelledWinner(w);
}

/**
 * @param {Function} getTeamCode - (teamName, teams) => string
 */
export function getMatchResultLabel(match, getTeamCode, teams) {
  const w = (match?.winner || '').trim();
  if (!w) return '—';
  if (w === MATCH_WINNER_DRAW) return 'Draw';
  if (w === MATCH_WINNER_CANCELLED) return 'Cancelled';
  return getTeamCode(w, teams) || w;
}

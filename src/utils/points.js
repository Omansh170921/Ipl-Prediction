import { isDrawOrCancelledWinner } from './matchOutcomes.js';

export const to2Decimals = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Per-match multiplier applied only to pool points for correct predictions (winners).
 * Wrong and not-participated penalties are never multiplied. Default 1 when missing/invalid.
 */
export function getMatchPointsMultiplier(match) {
  const raw = match?.pointsMultiplier;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

/** UI text e.g. "X2 multiplier" (capital X). Empty string when value is 1 or invalid. */
export function formatMultiplierLabel(multiplierValue) {
  const n =
    typeof multiplierValue === 'number'
      ? multiplierValue
      : parseFloat(String(multiplierValue ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n === 1) return '';
  const rounded = to2Decimals(n);
  const numPart = Number.isInteger(rounded) ? String(Math.trunc(rounded)) : String(rounded);
  return `X${numPart} multiplier`;
}

/** Same as formatMultiplierLabel(getMatchPointsMultiplier(match)). */
export function formatMatchMultiplierUi(match) {
  return formatMultiplierLabel(getMatchPointsMultiplier(match));
}

/**
 * Calculate points for a completed match.
 * @param {Object} match - Match with winner, team1, team2
 * @param {Array} allUsers - All users { id, username, ... }
 * @param {Array} matchPredictions - Predictions for this match { userId, predictedWinner }
 * @param {Object} pointRules - { notParticipatedPoints: number, wrongPredictionPoints: number } (positive values, applied as negative)
 * @returns {Object} { userPoints, summary: { pool, basePointsPerWinner, pointsMultiplier, pointsPerWinner, ... } }
 */
export function calculateMatchPoints(match, allUsers, matchPredictions, pointRules) {
  const notParticipatedPenalty = Math.abs(Number(pointRules?.notParticipatedPoints) || 7);
  const wrongPenalty = Math.abs(Number(pointRules?.wrongPredictionPoints) || 5);
  const winner = (match.winner || '').trim();
  if (isDrawOrCancelledWinner(winner)) {
    return {
      userPoints: {},
      summary: {
        totalUsers: allUsers?.length || 0,
        winners: 0,
        wrong: 0,
        notParticipated: 0,
        pool: 0,
        pointsPerWinner: 0,
        basePointsPerWinner: 0,
        pointsMultiplier: 1,
      },
    };
  }
  if (!winner) return { userPoints: {}, summary: {} };

  const predMap = new Map();
  (matchPredictions || []).forEach(p => predMap.set(p.userId, p.predictedWinner));

  const winners = [];
  const wrong = [];
  const notParticipated = [];

  const winnerNorm = winner.toLowerCase().trim();
  (allUsers || []).forEach(u => {
    const uid = u.id || u.uid;
    if (!uid) return;
    const predicted = predMap.get(uid);
    const predNorm = (predicted || '').toLowerCase().trim();
    if (!predicted) {
      notParticipated.push(uid);
    } else if (predNorm === winnerNorm) {
      winners.push(uid);
    } else {
      wrong.push(uid);
    }
  });

  const pool = to2Decimals(wrong.length * wrongPenalty + notParticipated.length * notParticipatedPenalty);
  const basePointsPerWinner = to2Decimals(winners.length > 0 ? pool / winners.length : 0);
  const pointsMultiplier = getMatchPointsMultiplier(match);
  const pointsPerWinner = to2Decimals(basePointsPerWinner * pointsMultiplier);

  const userPoints = {};
  wrong.forEach(uid => { userPoints[uid] = to2Decimals(-wrongPenalty); });
  notParticipated.forEach(uid => { userPoints[uid] = to2Decimals(-notParticipatedPenalty); });
  winners.forEach(uid => { userPoints[uid] = pointsPerWinner; });

  return {
    userPoints,
    summary: {
      totalUsers: allUsers?.length || 0,
      winners: winners.length,
      wrong: wrong.length,
      notParticipated: notParticipated.length,
      pool,
      /** Share of pool per correct prediction before multiplier */
      basePointsPerWinner,
      pointsMultiplier,
      /** Points each correct predictor receives (after multiplier) */
      pointsPerWinner,
    },
  };
}

/**
 * Points each correct predictor would get if hypotheticalWinner wins the match,
 * using the same pool rules as calculateMatchPoints and current saved predictions.
 */
export function expectedPointsIfWinner(match, allUsers, matchPredictions, pointRules, hypotheticalWinner) {
  const hw = (hypotheticalWinner || '').trim();
  if (!hw || !Array.isArray(allUsers) || allUsers.length === 0) return null;
  const fakeMatch = { ...match, winner: hw };
  const { summary } = calculateMatchPoints(fakeMatch, allUsers, matchPredictions, pointRules);
  if (!summary || summary.pointsPerWinner == null) return null;
  return to2Decimals(summary.pointsPerWinner);
}

/**
 * Calculate leaderboard (total points per user) across all completed matches.
 * Uses stored pointResults when available, otherwise calculates on the fly.
 */
export function calculateLeaderboard(completedMatches, allUsers, allPredictionsByMatch, pointRules) {
  const totals = {};
  (allUsers || []).forEach(u => { totals[u.id || u.uid] = 0; });

  (completedMatches || []).forEach(match => {
    if (match.pointResults && typeof match.pointResults === 'object') {
      Object.entries(match.pointResults).forEach(([uid, pts]) => {
        totals[uid] = to2Decimals((totals[uid] || 0) + Number(pts));
      });
    } else {
      const preds = allPredictionsByMatch[match.id] || [];
      const { userPoints } = calculateMatchPoints(match, allUsers, preds, pointRules);
      Object.entries(userPoints || {}).forEach(([uid, pts]) => {
        totals[uid] = to2Decimals((totals[uid] || 0) + pts);
      });
    }
  });

  return totals;
}

/**
 * Sum leaderboard bonus points from season prediction contests (declared winners).
 * Stored on user as seasonContestLeaderboard: { [contextDocId]: { points, title, contextCode, scoredAt, declaredAt? } }.
 * Points are written when an admin scores the challenge (from correct picks); optional declaredAt for legacy rows.
 */
export function sumSeasonContestLeaderboardPoints(user) {
  const m = user?.seasonContestLeaderboard;
  if (!m || typeof m !== 'object') return 0;
  return Object.values(m).reduce((acc, v) => acc + to2Decimals(Number(v?.points ?? 0)), 0);
}

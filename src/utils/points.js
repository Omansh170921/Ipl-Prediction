import { hasTeamWinnerForScoring, isDrawOrCancelledWinner } from './matchOutcomes.js';

export const to2Decimals = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Calculate points for a completed match.
 * @param {Object} match - Match with winner, team1, team2
 * @param {Array} allUsers - All users { id, username, ... }
 * @param {Array} matchPredictions - Predictions for this match { userId, predictedWinner }
 * @param {Object} pointRules - { notParticipatedPoints: number, wrongPredictionPoints: number } (positive values, applied as negative)
 * @returns {Object} { userPoints: { userId: number }, summary: { totalUsers, winners, wrong, notParticipated, pool } }
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
  const pointsPerWinner = to2Decimals(winners.length > 0 ? pool / winners.length : 0);

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
 * Per user for team-winner matches: correct, wrong, not predicted.
 * League-wide: drawResultCount = completed matches with draw or cancelled (no team winner).
 */
export function countPredictionPickStatsPerUser(completedMatches, users, predsByMatch) {
  const correct = {};
  const wrong = {};
  const notPredicted = {};
  (users || []).forEach((u) => {
    correct[u.id] = 0;
    wrong[u.id] = 0;
    notPredicted[u.id] = 0;
  });
  let drawResultCount = 0;
  (completedMatches || []).forEach((match) => {
    const w = (match.winner || '').trim();
    if (!w) return;
    if (isDrawOrCancelledWinner(w)) {
      drawResultCount += 1;
      return;
    }
    if (!hasTeamWinnerForScoring(match)) return;
    const mid = match.id != null ? String(match.id) : '';
    const preds = predsByMatch?.[mid] || predsByMatch?.[match.id] || [];
    const winnerNorm = w.toLowerCase().trim();
    const predMap = new Map();
    preds.forEach((p) => predMap.set(p.userId, p.predictedWinner));
    (users || []).forEach((u) => {
      const uid = u.id;
      const pred = predMap.get(uid);
      if (pred == null || String(pred).trim() === '') {
        notPredicted[uid] = (notPredicted[uid] || 0) + 1;
        return;
      }
      const predNorm = String(pred).toLowerCase().trim();
      if (predNorm === winnerNorm) {
        correct[uid] = (correct[uid] || 0) + 1;
      } else {
        wrong[uid] = (wrong[uid] || 0) + 1;
      }
    });
  });
  return { correct, wrong, notPredicted, drawResultCount };
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

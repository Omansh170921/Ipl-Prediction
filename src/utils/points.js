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

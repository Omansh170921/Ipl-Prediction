import { to2Decimals } from './points';

/**
 * Points deducted for a wrong Cricket Insight answer (positive number).
 * Uses `insightWrongAnswerPenalty` on cricket insights settings, else match `pointRules.wrongPredictionPoints`, else 0.25.
 */
export function getInsightWrongAnswerPenalty({ cricketInsightsConfig, pointRules } = {}) {
  const raw = cricketInsightsConfig?.insightWrongAnswerPenalty;
  if (raw != null && raw !== '' && !Number.isNaN(Number(raw))) {
    return Math.max(0, to2Decimals(Math.abs(Number(raw))));
  }
  const fromRules = pointRules?.wrongPredictionPoints;
  if (fromRules != null && fromRules !== '' && !Number.isNaN(Number(fromRules))) {
    return Math.max(0, to2Decimals(Math.abs(Number(fromRules))));
  }
  return 0.25;
}

/** Delta to apply to match insightPointResults when correct answer changes. */
export function insightPointDeltaOnAnswerChange(wasRight, nowRight, penalty) {
  const p = Number(penalty) || 0;
  const oldPart = wasRight ? 1 : -p;
  const newPart = nowRight ? 1 : -p;
  return to2Decimals(newPart - oldPart);
}

function normInsightAnswer(s) {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * Net insight points for one match (+1 per correct, −penalty per wrong), same as admin scoring and history modal.
 * @param {Array<{ id: string, correctAnswer?: string }>} questionsForMatch
 * @param {Record<string, string>} answersByQuestionId
 * @param {number} wrongAnswerPenalty
 */
export function insightMatchNetPoints(questionsForMatch, answersByQuestionId, wrongAnswerPenalty) {
  const p = Number(wrongAnswerPenalty) || 0;
  let correct = 0;
  let wrong = 0;
  for (const q of questionsForMatch || []) {
    const rawAns = answersByQuestionId[String(q.id)];
    if (rawAns == null || String(rawAns).trim() === '') continue;
    const ca = q.correctAnswer;
    if (ca == null || String(ca).trim() === '') continue;
    if (normInsightAnswer(rawAns) === normInsightAnswer(ca)) correct += 1;
    else wrong += 1;
  }
  return to2Decimals(correct - wrong * p);
}

/**
 * Build maps from Firestore snapshots for leaderboard recalculation.
 * @param {Array<{ id: string, data: () => object }>} questionDocSnaps
 * @param {Array<{ id: string, data: () => object }>} answerDocSnaps
 */
export function buildInsightRecalcFromSnapshots(questionDocSnaps, answerDocSnaps) {
  const questionsByMatchId = {};
  (questionDocSnaps || []).forEach((d) => {
    const data = d.data();
    const mid = data.matchId;
    if (!mid) return;
    const key = String(mid);
    if (!questionsByMatchId[key]) questionsByMatchId[key] = [];
    questionsByMatchId[key].push({ id: d.id, ...data });
  });
  const answersByUserId = {};
  (answerDocSnaps || []).forEach((d) => {
    const x = d.data();
    const uid = x.userId;
    const qid = x.questionId != null ? String(x.questionId) : '';
    if (!uid || !qid) return;
    if (!answersByUserId[uid]) answersByUserId[uid] = {};
    answersByUserId[uid][qid] = x.answer;
  });
  return { questionsByMatchId, answersByUserId };
}

/**
 * Sum recalculated insight points per user over completed matches (order-independent).
 * @param {Array<{ id: string }>} users
 * @param {Array} completedMatchesWithResult
 * @param {Record<string, Array>} questionsByMatchId
 * @param {Record<string, Record<string, string>>} answersByUserId
 * @param {number} wrongAnswerPenalty
 * @returns {Record<string, number>}
 */
export function computeRecalculatedInsightTotalsByUser(
  users,
  completedMatchesWithResult,
  questionsByMatchId,
  answersByUserId,
  wrongAnswerPenalty
) {
  /** @type {Record<string, number>} */
  const totals = {};
  (users || []).forEach((u) => {
    totals[u.id] = 0;
  });
  for (const m of completedMatchesWithResult || []) {
    const mid = String(m.id);
    const qs = questionsByMatchId[mid] || [];
    for (const u of users || []) {
      const myAnswers = answersByUserId[u.id] || {};
      const delta = insightMatchNetPoints(qs, myAnswers, wrongAnswerPenalty);
      totals[u.id] = to2Decimals((totals[u.id] || 0) + delta);
    }
  }
  return totals;
}

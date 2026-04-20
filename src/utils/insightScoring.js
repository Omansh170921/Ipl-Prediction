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

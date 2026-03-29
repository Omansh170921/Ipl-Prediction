/**
 * Returns true while the prediction window is still open (current time before cutoff).
 */
export function isPredictionEligible(match) {
  const threshold = match.thresholdTime || match.time || '23:59';
  const cutoff = new Date(match.date + 'T' + (threshold.length === 5 ? threshold : '23:59') + ':00');
  return new Date() < cutoff;
}

/** @typedef {'always' | 'afterCutoff'} CrowdVisibilityMode */

/**
 * System default + optional per-match override (Firestore: match.crowdPredictionVisibility).
 * @param {{ crowdPredictionVisibility?: string } | null | undefined} programConfig
 * @param {{ crowdPredictionVisibility?: string } | null | undefined} match
 * @returns {CrowdVisibilityMode}
 */
export function effectiveCrowdPredictionVisibility(programConfig, match) {
  const m = (match?.crowdPredictionVisibility || '').trim().toLowerCase();
  if (m === 'always' || m === 'aftercutoff') {
    return m === 'aftercutoff' ? 'afterCutoff' : 'always';
  }
  const p = (programConfig?.crowdPredictionVisibility || '').trim().toLowerCase();
  if (p === 'aftercutoff') return 'afterCutoff';
  return 'always';
}

/**
 * Whether to show crowd prediction % for this match at the current time.
 * @param {{ crowdPredictionVisibility?: string } | null | undefined} programConfig
 * @param {{ crowdPredictionVisibility?: string } | null | undefined} match
 * @param {boolean} isEligible - result of isPredictionEligible(match)
 */
export function shouldShowCrowdPrediction(programConfig, match, isEligible) {
  const mode = effectiveCrowdPredictionVisibility(programConfig, match);
  if (mode === 'afterCutoff') return !isEligible;
  return true;
}

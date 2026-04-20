/**
 * Local cutoff instant for match predictions (same rule as predict-before / isPredictionEligible).
 * @param {{ date?: string, thresholdTime?: string, time?: string } | null | undefined} match
 * @returns {Date | null}
 */
export function getMatchPredictionCutoffDate(match) {
  if (!match || match.date == null || String(match.date).trim() === '') return null;
  const threshold = match.thresholdTime || match.time || '23:59';
  const t = String(threshold).trim();
  const timePart = t.length === 5 && /^\d{1,2}:\d{2}$/.test(t) ? t : '23:59';
  const cutoff = new Date(`${String(match.date).trim()}T${timePart}:00`);
  return Number.isNaN(cutoff.getTime()) ? null : cutoff;
}

/**
 * Returns true while the prediction window is still open (current time before cutoff).
 */
export function isPredictionEligible(match) {
  const cutoff = getMatchPredictionCutoffDate(match);
  if (!cutoff) return false;
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
 * Minutes after the prediction cutoff to wait before showing crowd % (afterCutoff mode only).
 * Read from settings/programConfig; default 10.
 * @param {{ crowdPredictionMinutesAfterCutoff?: number | string } | null | undefined} programConfig
 */
export function getCrowdPredictionMinutesAfterCutoff(programConfig) {
  const raw = programConfig?.crowdPredictionMinutesAfterCutoff;
  if (raw == null || raw === '') return 10;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 10;
  return Math.max(0, Math.min(24 * 60, n));
}

/**
 * First instant when crowd % may appear for afterCutoff mode (cutoff + configured delay).
 * @param {{ crowdPredictionVisibility?: string, crowdPredictionMinutesAfterCutoff?: number | string } | null | undefined} programConfig
 */
export function getCrowdPredictionRevealInstant(match, programConfig) {
  const cutoff = getMatchPredictionCutoffDate(match);
  if (!cutoff) return null;
  const min = getCrowdPredictionMinutesAfterCutoff(programConfig);
  return new Date(cutoff.getTime() + min * 60 * 1000);
}

/**
 * Whether to show crowd prediction % for this match at the current time.
 * When mode is afterCutoff, shows only after prediction cutoff + crowdPredictionMinutesAfterCutoff (from program config).
 * @param {{ crowdPredictionVisibility?: string, crowdPredictionMinutesAfterCutoff?: number | string } | null | undefined} programConfig
 * @param {{ crowdPredictionVisibility?: string } | null | undefined} match
 */
export function shouldShowCrowdPrediction(programConfig, match) {
  const mode = effectiveCrowdPredictionVisibility(programConfig, match);
  if (mode === 'afterCutoff') {
    const reveal = getCrowdPredictionRevealInstant(match, programConfig);
    if (!reveal) return false;
    return new Date() >= reveal;
  }
  return true;
}

/**
 * Returns true while the prediction window is still open (current time before cutoff).
 */
export function isPredictionEligible(match) {
  const threshold = match.thresholdTime || match.time || '23:59';
  const cutoff = new Date(match.date + 'T' + (threshold.length === 5 ? threshold : '23:59') + ':00');
  return new Date() < cutoff;
}

/**
 * Pending / approved insight questions count toward per-user and per-match limits.
 * Rejected questions do not — the user may submit another question for that match.
 */
export function insightQuestionCountsTowardLimits(q) {
  const s = (q?.status || '').toLowerCase();
  return s !== 'rejected';
}

/** Shown on dashboard for answering: approved, not closed by admin. */
export function isInsightQuestionAnswerableInUi(q) {
  return q?.approved === true && q?.answersDisabled !== true;
}

/** Resolve Firestore user id to username for insight approval UI. */
export function formatInsightUserLabel(usersList, uid) {
  if (!uid) return '—';
  const u = (usersList || []).find((x) => x.id === uid);
  const name = (u?.username || u?.name || '').trim();
  return name || String(uid).slice(0, 10);
}

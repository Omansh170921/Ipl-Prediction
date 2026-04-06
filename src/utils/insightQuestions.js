/**
 * Pending / approved insight questions count toward per-user and per-match limits.
 * Rejected questions do not — the user may submit another question for that match.
 */
export function insightQuestionCountsTowardLimits(q) {
  const s = (q?.status || '').toLowerCase();
  return s !== 'rejected';
}

function isInsightApproved(q) {
  return q?.approved === true || q?.approved === 'true';
}

/** Shown on dashboard for answering: approved, not closed by admin. */
export function isInsightQuestionAnswerableInUi(q) {
  return isInsightApproved(q) && q?.answersDisabled !== true;
}

/**
 * All approved questions for a match stay visible after the user submits an answer
 * (so they still see the question, their pick, and the official correct answer when set).
 */
export function isInsightQuestionVisibleInDashboard(q) {
  return isInsightApproved(q);
}

/** Resolve Firestore user id to username for insight approval UI. */
export function formatInsightUserLabel(usersList, uid) {
  if (!uid) return '—';
  const u = (usersList || []).find((x) => x.id === uid);
  const name = (u?.username || u?.name || '').trim();
  return name || String(uid).slice(0, 10);
}

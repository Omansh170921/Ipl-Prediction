/**
 * Season / qualifier-style prediction contexts (e.g. which teams reach playoffs).
 * Points are configured per exact number of correct picks from the user's selection.
 */

import { getAppTodayDate } from './calendarDate';

/** URL-safe slug for display / exports (Firestore doc id remains the canonical id). */
export function slugifyContextTitle(title) {
  return (
    String(title || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'contest'
  );
}

/** Human-readable unique code stored on each context (e.g. ipl-qf-a3x9k2). */
export function generateContextCode(title) {
  const slug = slugifyContextTitle(title);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${slug}-${suffix}`;
}

export function normalizeContextTiers(tiers) {
  if (!Array.isArray(tiers)) return [];
  const seen = new Set();
  const out = [];
  for (const t of tiers) {
    const correctCount = Math.max(0, parseInt(t.correctCount, 10) || 0);
    const points = Math.round(Number(t.points) * 100) / 100 || 0;
    if (seen.has(correctCount)) continue;
    seen.add(correctCount);
    out.push({ correctCount, points });
  }
  out.sort((a, b) => b.correctCount - a.correctCount);
  return out;
}

export function pointsForCorrectPredictions(correctCount, tiers) {
  const norm = normalizeContextTiers(tiers);
  const row = norm.find((t) => t.correctCount === correctCount);
  return row ? row.points : 0;
}

export function countCorrectPicks(selectedTeamIds, officialTeamIds) {
  const off = new Set((officialTeamIds || []).map((id) => String(id)));
  let n = 0;
  for (const id of selectedTeamIds || []) {
    if (off.has(String(id))) n += 1;
  }
  return n;
}

/** Normalizes stored deadline for an HTML datetime-local input (YYYY-MM-DDTHH:mm). */
export function deadlineToDatetimeLocalValue(deadline) {
  if (deadline == null || deadline === '') return '';
  const s = String(deadline).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T23:59`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Instant for Firestore `deadlineAt` (matches datetime-local + date-only end-of-day). */
export function deadlineStringToMillis(deadline) {
  const local = deadlineToDatetimeLocalValue(deadline);
  if (!local) return null;
  const ms = new Date(local).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * True after the deadline. Date-only strings (YYYY-MM-DD) use app calendar "today" (legacy).
 * Date-time strings use the browser's local instant (same as datetime-local input).
 */
export function isContextDeadlinePassed(deadline) {
  if (deadline == null || String(deadline).trim() === '') return false;
  const s = String(deadline).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s < getAppTodayDate();
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) return false;
  return Date.now() > t;
}

export const DEFAULT_CONTEXT_TIERS = [
  { correctCount: 4, points: 25 },
  { correctCount: 3, points: 15 },
  { correctCount: 2, points: 10 },
  { correctCount: 1, points: 5 },
];

/**
 * From scored responses (pointsAwarded set), return all userIds tied for the highest score.
 * @param {Array<{ userId: string, pointsAwarded: number }>} entries
 * @returns {{ winnerUserIds: string[], winningPoints: number } | null}
 */
export function computeContestWinnerUserIds(entries) {
  if (!entries || entries.length === 0) return null;
  let max = -Infinity;
  for (const e of entries) {
    const p = Number(e.pointsAwarded);
    if (Number.isNaN(p)) continue;
    if (p > max) max = p;
  }
  if (max === -Infinity) return null;
  const winnerUserIds = entries.filter((e) => Number(e.pointsAwarded) === max).map((e) => e.userId);
  return { winnerUserIds, winningPoints: max };
}

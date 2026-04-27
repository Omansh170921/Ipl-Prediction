import { getPredictionSavedIso } from './predictionTime';

/**
 * @param {unknown} v
 * @returns {string|null}
 */
export function coerceFirestoreTimeToIso(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'object' && typeof v.toDate === 'function') {
    try {
      const d = v.toDate();
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    } catch {
      return null;
    }
  }
  if (typeof v === 'object' && v.seconds != null) {
    const ms = v.seconds * 1000 + (v.nanoseconds || 0) / 1e6;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/**
 * Only entries stored in `predictionChangeLog` (no doc-level fallback).
 * @param {Record<string, unknown>|null|undefined} data
 * @returns {Array<{ predictedWinner: string, atIso: string }>}
 */
export function parseStoredPredictionChangeLogArrayOnly(data) {
  if (!data || typeof data !== 'object') return [];
  const raw = data.predictionChangeLog;
  const rows = [];
  if (!Array.isArray(raw)) return rows;
  const docFallback =
    getPredictionSavedIso(data) ||
    coerceFirestoreTimeToIso(data.updatedAt) ||
    coerceFirestoreTimeToIso(data.createdAt);
  let corruptSeq = 0;
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const w = String(e.predictedWinner ?? e.team ?? '').trim();
    if (!w) continue;
    let atIso = coerceFirestoreTimeToIso(e.at ?? e.time ?? e.changedAt ?? e.ts);
    if (!atIso && docFallback) {
      atIso = new Date(new Date(docFallback).getTime() + corruptSeq++).toISOString();
    }
    if (!atIso) continue;
    rows.push({ predictedWinner: w, atIso });
  }
  rows.sort((a, b) => new Date(a.atIso).getTime() - new Date(b.atIso).getTime());
  return rows;
}

/**
 * Ensure each entry's `at` is strictly after the previous (avoids equal timestamps breaking sort / admin display).
 * @param {Array<{ predictedWinner: string, at: string }>} entries
 */
export function ensureMonotonicPredictionLogTimes(entries) {
  if (!entries || entries.length === 0) return [];
  let lastMs = 0;
  return entries.map((e) => {
    const w = String(e.predictedWinner ?? '').trim();
    let t = new Date(e.at).getTime();
    if (Number.isNaN(t)) t = lastMs + 1;
    if (t <= lastMs) t = lastMs + 1;
    lastMs = t;
    return { predictedWinner: w, at: new Date(t).toISOString() };
  });
}

/**
 * Baseline timestamp for a prediction doc when backfilling the log (preserve original save time, not "now" on migrate).
 * @param {Record<string, unknown>|null|undefined} prevData
 * @param {string} nowIso
 */
export function baselineAtForPredictionDoc(prevData, nowIso) {
  return (
    getPredictionSavedIso(prevData) ||
    coerceFirestoreTimeToIso(prevData?.updatedAt) ||
    coerceFirestoreTimeToIso(prevData?.createdAt) ||
    nowIso
  );
}

/**
 * Legacy / empty stored array: persist a one-line log on next save (including same-team save) so Firestore always has history.
 */
export function shouldPersistPredictionLogBaseline(prevData, newWinner) {
  if (!prevData || typeof prevData !== 'object') return false;
  const nw = String(newWinner ?? '').trim();
  const pw = String(prevData.predictedWinner ?? '').trim();
  if (!nw || nw !== pw) return false;
  const stored = parseStoredPredictionChangeLogArrayOnly(prevData);
  return stored.length === 0;
}

/**
 * Sorted ascending by time. Prefers stored `predictionChangeLog`; falls back to one synthetic row for legacy docs.
 * @param {Record<string, unknown>|null|undefined} data
 * @returns {Array<{ predictedWinner: string, atIso: string }>}
 */
export function getSortedPredictionChangeLog(data) {
  if (!data || typeof data !== 'object') return [];
  const fromArray = parseStoredPredictionChangeLogArrayOnly(data);
  if (fromArray.length > 0) return fromArray;
  const w = String(data.predictedWinner || '').trim();
  const atIso =
    getPredictionSavedIso(data) ||
    coerceFirestoreTimeToIso(data.updatedAt) ||
    coerceFirestoreTimeToIso(data.createdAt);
  if (w && atIso) return [{ predictedWinner: w, atIso }];
  return [];
}

/**
 * Number of times the user switched to a different pick after their first saved version (0 if only one version).
 * @param {Array<{ atIso?: string }>} log
 */
export function countPredictionSwitches(log) {
  if (!log || log.length <= 1) return 0;
  return log.length - 1;
}

/**
 * @param {Record<string, unknown>|undefined|null} prev
 * @param {string} newWinner raw from UI
 * @param {string} nowIso
 * @returns {{ log: Array<{ predictedWinner: string, at: string }>, shouldWriteLog: boolean }}
 */
export function buildPredictionChangeLogForSave(prev, newWinner, nowIso) {
  const nw = String(newWinner ?? '').trim();
  if (!prev || typeof prev !== 'object') {
    const log = nw ? ensureMonotonicPredictionLogTimes([{ predictedWinner: nw, at: nowIso }]) : [];
    return { log, shouldWriteLog: true };
  }
  const prevWinner = String(prev.predictedWinner ?? '').trim();
  if (nw === prevWinner) {
    return { log: [], shouldWriteLog: false };
  }
  let log = [];
  const stored = parseStoredPredictionChangeLogArrayOnly(prev);
  if (stored.length > 0) {
    log = stored.map((r) => ({ predictedWinner: r.predictedWinner, at: r.atIso }));
  } else if (prevWinner) {
    const atPrev = baselineAtForPredictionDoc(prev, nowIso);
    log = [{ predictedWinner: prevWinner, at: atPrev }];
  }
  log.push({ predictedWinner: nw, at: nowIso });
  return { log: ensureMonotonicPredictionLogTimes(log), shouldWriteLog: true };
}

/**
 * One-line log for same-team save when Firestore has no stored log yet (migration).
 */
export function buildBaselinePredictionChangeLog(prevData, newWinner, nowIso) {
  const nw = String(newWinner ?? '').trim();
  if (!nw) return [];
  const at = baselineAtForPredictionDoc(prevData, nowIso);
  return ensureMonotonicPredictionLogTimes([{ predictedWinner: nw, at }]);
}

/**
 * Merge strategy for Dashboard saves: full log to write, or undefined to skip field (merge keeps existing).
 * @param {Record<string, unknown>|null|undefined} prevData
 * @param {boolean} docExists
 * @param {string} predictedWinner
 * @param {string} nowIso
 * @returns {{ predictionChangeLog: Array<{ predictedWinner: string, at: string }>|null }}
 */
export function resolvePredictionChangeLogForPersist(prevData, docExists, predictedWinner, nowIso) {
  const { log: built, shouldWriteLog } = buildPredictionChangeLogForSave(prevData, predictedWinner, nowIso);

  if (!docExists) {
    return { predictionChangeLog: built.length ? built : null };
  }

  if (shouldWriteLog && built.length) {
    return { predictionChangeLog: built };
  }

  if (shouldPersistPredictionLogBaseline(prevData, predictedWinner)) {
    const baseline = buildBaselinePredictionChangeLog(prevData, predictedWinner, nowIso);
    return { predictionChangeLog: baseline.length ? baseline : null };
  }

  return { predictionChangeLog: null };
}

/**
 * @param {string|null|undefined} atIso
 */
export function formatPredictionHistoryLocalTime(atIso) {
  if (!atIso) return '—';
  const d = new Date(atIso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Best-effort ISO timestamp from a Firestore prediction document (updatedAt, createdAt, etc.).
 * @param {Record<string, unknown>|null|undefined} data
 * @returns {string|null}
 */
export function getPredictionSavedIso(data) {
  if (!data || typeof data !== 'object') return null;
  const v = data.updatedAt ?? data.createdAt ?? data.predictedAt;
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v.toDate === 'function') {
    try {
      return v.toDate().toISOString();
    } catch {
      return null;
    }
  }
  if (typeof v === 'object' && v.seconds != null) {
    const ms = v.seconds * 1000 + (v.nanoseconds || 0) / 1e6;
    return new Date(ms).toISOString();
  }
  return null;
}

/** Local wall-clock time HH:MM (24h). */
export function formatTimeHH24(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Converts string to initcap: first letter of each word uppercase, rest lowercase.
 * Words are split by spaces and underscores (e.g. "john_doe" → "John Doe").
 */
export function toInitCap(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .split(/[\s_]+/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : ''))
    .join(' ');
}

/**
 * Format an ISO or date string for display as dd-mm-yyyy (local calendar date).
 */
export function formatDdMmYyyy(isoOrDate) {
  if (isoOrDate == null || isoOrDate === '') return '';
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return String(isoOrDate);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Prediction context deadline: YYYY-MM-DD (legacy) or YYYY-MM-DDTHH:mm for display (local time).
 */
export function formatContextDeadlineDisplay(deadline) {
  if (deadline == null || deadline === '') return '';
  const s = String(deadline).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00`);
    if (Number.isNaN(d.getTime())) return s;
    return formatDdMmYyyy(d);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${formatDdMmYyyy(d)} · ${time}`;
}

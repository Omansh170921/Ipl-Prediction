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

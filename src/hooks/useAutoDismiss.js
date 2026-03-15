import { useEffect } from 'react';

/**
 * Auto-dismiss a value (error, success message) after a delay.
 * @param {string} value - The value to watch (error, message, etc.)
 * @param {function} setter - Function to clear the value (e.g. setError, setMessage)
 * @param {number} delayMs - Delay in milliseconds (default 3000)
 */
export function useAutoDismiss(value, setter, delayMs = 3000) {
  useEffect(() => {
    if (!value || !setter) return;
    const t = setTimeout(() => setter(''), delayMs);
    return () => clearTimeout(t);
  }, [value, setter, delayMs]);
}

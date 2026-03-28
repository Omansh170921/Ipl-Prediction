/**
 * Match dates in the app are stored as YYYY-MM-DD calendar strings.
 * Using UTC for "today" breaks IST users until UTC crosses midnight (e.g. after 5:30 AM IST).
 */

function getTimeZone() {
  return import.meta.env.VITE_APP_CALENDAR_TIMEZONE?.trim() || 'Asia/Kolkata';
}

/**
 * Calendar date YYYY-MM-DD for `date` in the app timezone (default Asia/Kolkata / IST).
 */
export function getCalendarDateString(date = new Date(), timeZone = getTimeZone()) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

/** Today's calendar date in the app timezone — use for "today's matches" and date filters. */
export function getAppTodayDate() {
  return getCalendarDateString(new Date());
}

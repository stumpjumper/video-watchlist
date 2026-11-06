// A stored "YYYY-MM-DD" is a calendar day, not an instant. `new Date("2026-10-29")`
// is UTC midnight, which is the previous evening in US time zones.

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcCalendarDay(raw: string): Date | null {
  const match = DATE_ONLY.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

export function formatStoredDate(
  iso: string | null | undefined,
  options: Intl.DateTimeFormatOptions,
  locales: Intl.LocalesArgument = 'en-US',
): string | null {
  if (!iso) return null;
  const raw = iso.trim();
  if (!raw) return null;
  if (DATE_ONLY.test(raw)) {
    const date = utcCalendarDay(raw);
    if (!date) return null;
    return date.toLocaleDateString(locales, { ...options, timeZone: 'UTC' });
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locales, options);
}

/** Long date spoken in the TTS intro, for example "October 29, 2026". */
export function spokenPublishedDate(publishedAt: string | null | undefined): string | null {
  return formatStoredDate(publishedAt, { year: 'numeric', month: 'long', day: 'numeric' });
}

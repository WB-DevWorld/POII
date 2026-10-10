// #20 conversation import: timestamps from exports, normalised or explicitly unknown. Pure.

const ISO = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** An ISO 8601 string with an offset → UTC with milliseconds; anything else (or missing) → null (unknown). */
export function normaliseIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = ISO.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ? match[3].slice(0, 4).padEnd(4, '0') : '.000';
  const zone = match[4] === 'Z' ? 'Z' : match[4]!.includes(':') ? match[4]! : `${match[4]!.slice(0, 3)}:${match[4]!.slice(3)}`;
  const date = new Date(`${match[1]}T${match[2]}${fraction}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Epoch seconds (ChatGPT's create_time, possibly fractional) → ISO; null, zero, negative or absurd values → null. */
export function epochSecondsToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(Math.round(value * 1000));
  // Before 2000 or after 2200 is not a real export timestamp; say unknown rather than invent a time.
  const year = date.getUTCFullYear();
  if (Number.isNaN(year) || year < 2000 || year > 2200) return null;
  return date.toISOString();
}

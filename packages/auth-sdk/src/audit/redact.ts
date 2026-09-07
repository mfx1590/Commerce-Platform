// PII redaction for audit_log before/after snapshots (issue #14). The audit trail must show WHAT changed
// without becoming a PII store itself: identifying values are replaced, ids and statuses stay readable.

/** Field names whose values are replaced with REDACTED wherever they appear (case-insensitive). */
export const PII_FIELDS: readonly string[] = [
  'email',
  'phone',
  'line1',
  'line2',
  'key_hash',
  'first_name',
  'last_name',
];

export const REDACTED = '[redacted]';

const piiSet = new Set(PII_FIELDS.map((f) => f.toLowerCase()));

/**
 * Deep-copies `value`, replacing the value of every PII field (see PII_FIELDS) with "[redacted]".
 * Never mutates the input. null/undefined pass through; arrays and nested objects are walked.
 */
export function redactPii<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redactPii(v)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        piiSet.has(k.toLowerCase()) && v !== null && v !== undefined ? REDACTED : redactPii(v);
    }
    return out as T;
  }
  return value;
}

/**
 * A campaign landing is live between `startsAt` and `endsAt` (either may be absent). Unparseable
 * dates fail closed: a document whose schedule cannot be read is not shown.
 */
export function campaignIsLive(
  landing: { startsAt?: string | undefined; endsAt?: string | undefined },
  now: number = Date.now(),
): boolean {
  if (landing.startsAt !== undefined) {
    const startsAt = Date.parse(landing.startsAt);
    if (Number.isNaN(startsAt) || now < startsAt) return false;
  }
  if (landing.endsAt !== undefined) {
    const endsAt = Date.parse(landing.endsAt);
    if (Number.isNaN(endsAt) || now > endsAt) return false;
  }
  return true;
}

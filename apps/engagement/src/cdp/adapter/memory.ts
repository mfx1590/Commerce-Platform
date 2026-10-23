import type { CdpAdapter, CdpIdentifyCall, CdpSuppressCall, CdpTrackCall } from '../types.js';

/**
 * The in-memory CDP, and the only one that runs today: no RudderStack account exists (#553 decision). It is a
 * complete implementation rather than a stub, so a test asserts on what WOULD be sent, and `pnpm dev` leaves a
 * readable record without a network.
 *
 * `suppressed` is the regulation list: once an identity is in it, this adapter records that fact and a test can
 * assert an erasure really reached the CDP boundary.
 */
export class MemoryCdpAdapter implements CdpAdapter {
  readonly name = 'memory';
  readonly identifies: CdpIdentifyCall[] = [];
  readonly tracks: CdpTrackCall[] = [];
  readonly suppressions: CdpSuppressCall[] = [];
  /** Set when a call should fail, so the consumer's retry and dead-letter paths are testable. */
  failWith: Error | null = null;

  async identify(call: CdpIdentifyCall): Promise<void> {
    this.#check();
    this.identifies.push(call);
  }

  async track(call: CdpTrackCall): Promise<void> {
    this.#check();
    this.tracks.push(call);
  }

  async suppress(call: CdpSuppressCall): Promise<void> {
    this.#check();
    this.suppressions.push(call);
  }

  /** Every call in arrival order — what a test usually wants to assert on. */
  get all(): (CdpIdentifyCall | CdpTrackCall | CdpSuppressCall)[] {
    return [...this.identifies, ...this.tracks, ...this.suppressions];
  }

  get count(): number {
    return this.identifies.length + this.tracks.length + this.suppressions.length;
  }

  /** Has this identity been suppressed? (`customer_id`, or the `email_hash` for an anonymous one.) */
  isSuppressed(id: string): boolean {
    return this.suppressions.some((s) => s.identity.userId === id || s.identity.anonymousId === id);
  }

  reset(): void {
    this.identifies.length = 0;
    this.tracks.length = 0;
    this.suppressions.length = 0;
    this.failWith = null;
  }

  #check(): void {
    if (this.failWith) throw this.failWith;
  }
}

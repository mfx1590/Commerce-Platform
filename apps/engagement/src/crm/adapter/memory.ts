import type { CrmAdapter, CrmContact } from '../types.js';

/**
 * The in-memory CRM, and the only one that runs today: no Twenty instance exists (#553 decision). A complete
 * implementation rather than a stub, so a test asserts on exactly what WOULD be sent.
 *
 * Keyed on `externalId` (our customer id), like the real adapter, so "upsert twice, one contact" is a property
 * of the mock too and a redelivery test cannot pass here and fail against Twenty.
 */
export class MemoryCrmAdapter implements CrmAdapter {
  readonly name = 'memory';
  readonly contacts = new Map<string, CrmContact>();
  /** Every upsert in arrival order, including repeats — so a test can prove a redelivery wrote once. */
  readonly upserts: CrmContact[] = [];
  readonly removed: string[] = [];
  failWith: Error | null = null;

  async upsert(contact: CrmContact): Promise<void> {
    this.#check();
    this.upserts.push(contact);
    this.contacts.set(contact.externalId, contact);
  }

  async remove(externalId: string): Promise<void> {
    this.#check();
    this.removed.push(externalId);
    this.contacts.delete(externalId);
  }

  get(externalId: string): CrmContact | undefined {
    return this.contacts.get(externalId);
  }

  reset(): void {
    this.contacts.clear();
    this.upserts.length = 0;
    this.removed.length = 0;
    this.failWith = null;
  }

  #check(): void {
    if (this.failWith) throw this.failWith;
  }
}

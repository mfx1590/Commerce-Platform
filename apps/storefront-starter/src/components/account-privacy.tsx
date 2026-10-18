'use client';

import { Button, Input } from '@platform/ui';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { DELETE_CONFIRMATION } from '@/app/[locale]/(account)/account/account.config';
import {
  deleteAccountAction,
  requestExportAction,
  type AccountActionState,
} from '@/app/[locale]/(account)/account/actions';

const EMPTY: AccountActionState = {};

function Notice({ state, success }: { state: AccountActionState; success: string }) {
  if (state.error !== undefined) {
    return (
      <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
        {state.error}
      </p>
    );
  }
  if (state.ok === true) {
    return (
      <p role="status" className="rounded-md border border-success p-3 text-sm text-success">
        {success}
      </p>
    );
  }
  return null;
}

function Pending({ children, variant }: { children: React.ReactNode; variant?: 'destructive' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} {...(variant ? { variant } : {})}>
      {children}
    </Button>
  );
}

/** "Download my data" (#470, `requestMyExport`): the bundle is built by the core and announced by email. */
export function RequestExportForm() {
  const [state, formAction] = useActionState(requestExportAction, EMPTY);
  return (
    <form
      action={formAction}
      className="flex max-w-lg flex-col gap-3"
      aria-label="Download my data"
    >
      <p className="text-sm text-muted-foreground">
        Get a copy of the data this shop holds about you: your profile, addresses, consent and
        orders. We prepare the file and email you when it is ready to download.
      </p>
      <Notice
        state={state}
        success="Your export has been requested. We will email you when it is ready."
      />
      <div>
        <Pending>Download my data</Pending>
      </div>
    </form>
  );
}

/**
 * "Delete my account" (`deleteMe`): a typed confirmation, then the account in THIS shop is erased — the
 * action signs the customer out and sends them to the goodbye page. Orders stay on record (legal retention).
 */
export function DeleteAccountForm() {
  const [state, formAction] = useActionState(deleteAccountAction, EMPTY);
  return (
    <form
      action={formAction}
      className="flex max-w-lg flex-col gap-3"
      aria-label="Delete my account"
    >
      <p className="text-sm text-muted-foreground">
        This deletes your account in this shop: your profile, your saved addresses and your consent
        choices are erased and you are signed out. Your orders stay on record as the law requires.
        This cannot be undone.
      </p>
      <Notice state={state} success="Your account is being deleted." />
      <div className="flex flex-col gap-1">
        <label htmlFor="delete-confirmation" className="text-sm font-medium">
          Type {DELETE_CONFIRMATION} to confirm
        </label>
        <Input
          id="delete-confirmation"
          name="confirmation"
          autoComplete="off"
          invalid={state.fieldErrors?.confirmation !== undefined}
        />
        {state.fieldErrors?.confirmation === undefined ? null : (
          <p className="text-sm text-destructive">{state.fieldErrors.confirmation}</p>
        )}
      </div>
      <div>
        <Pending variant="destructive">Delete my account</Pending>
      </div>
    </form>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { FormError, SelectField, TextField } from '@/components/form/fields';
import { ActionRefusal } from '@/components/states/action-refusal';
import { assignRoleAction, inviteUserAction, revokeRoleAction } from '@/app/actions/roles';
import type { ActionRefusalInfo } from '@/lib/forms/action-result';
import { GRANTABLE, type ObjectType } from '@/lib/roles';

/** A store as the object select needs it: id and a label. */
export interface StoreOption {
  id: string;
  label: string;
}

interface Failure {
  message: string | null;
  refusal?: ActionRefusalInfo | undefined;
  fieldErrors?: Record<string, string>;
}

/** Object type + object + relation, with only the pairs the model can grant. */
function GrantFields({
  stores,
  objectType,
  setObjectType,
  objectId,
  setObjectId,
  relation,
  setRelation,
  allowNone,
}: {
  stores: readonly StoreOption[];
  objectType: ObjectType | '';
  setObjectType: (value: ObjectType | '') => void;
  objectId: string;
  setObjectId: (value: string) => void;
  relation: string;
  setRelation: (value: string) => void;
  allowNone: boolean;
}) {
  const relations = objectType === '' ? [] : GRANTABLE[objectType];
  return (
    <>
      <SelectField
        label={allowNone ? 'Initial relation on' : 'On'}
        value={objectType}
        onChange={(event) => {
          const next = event.currentTarget.value as ObjectType | '';
          setObjectType(next);
          setRelation(next === '' ? '' : (GRANTABLE[next][0] ?? ''));
          setObjectId(next === 'store' ? (stores[0]?.id ?? '') : '');
        }}
        options={[
          ...(allowNone ? [{ value: '', label: '— none —' }] : []),
          { value: 'organization', label: 'The organization (HQ)' },
          { value: 'store', label: 'A store' },
        ]}
      />
      {objectType === 'store' && (
        <SelectField
          label="Store"
          value={objectId}
          onChange={(event) => setObjectId(event.currentTarget.value)}
          options={stores.map((store) => ({ value: store.id, label: store.label }))}
        />
      )}
      {objectType !== '' && (
        <SelectField
          label="Relation"
          value={relation}
          onChange={(event) => setRelation(event.currentTarget.value)}
          options={relations.map((value) => ({ value, label: value.replace('_', ' ') }))}
        />
      )}
    </>
  );
}

/**
 * `inviteUser` (email + display name), then `assignRole` for the optional initial relation — the
 * contract's invite takes no role. Until the invitation email exists (SMTP, Integration 2b) the
 * person's first sign-in is set up by an admin in Keycloak; the form says so.
 */
export function InviteUserForm({
  organizationId,
  stores,
}: {
  organizationId: string;
  stores: readonly StoreOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [objectType, setObjectType] = useState<ObjectType | ''>('');
  const [objectId, setObjectId] = useState('');
  const [relation, setRelation] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<{ email: string; warning: string | null } | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    setDone(null);
    const initial =
      objectType === ''
        ? undefined
        : {
            relation: relation as (typeof GRANTABLE)['organization'][number],
            object_type: objectType,
            object_id: objectType === 'organization' ? organizationId : objectId,
          };
    startTransition(async () => {
      const result = await inviteUserAction({
        email: email.trim(),
        display_name: displayName.trim(),
        ...(initial === undefined ? {} : { initial }),
      });
      if (result.status === 'success') {
        setDone({ email: result.data.user.email, warning: result.data.assignmentError });
        setEmail('');
        setDisplayName('');
        setObjectType('');
        router.refresh();
        return;
      }
      setFailure({
        message: result.formError,
        refusal: result.refusal,
        fieldErrors: result.fieldErrors,
      });
    });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3" aria-label="Invite a staff user">
      {failure?.refusal !== undefined ? (
        <ActionRefusal refusal={failure.refusal} message={null} />
      ) : (
        <FormError message={failure?.message ?? null} />
      )}
      {done !== null && (
        <div role="status" className="text-sm">
          <p className="text-success">
            Invited {done.email}. Their first sign-in (password and authenticator) is set up by an
            admin in Keycloak until the invitation email exists.
          </p>
          {done.warning !== null && <p className="text-warning mt-1">{done.warning}</p>}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
          error={failure?.fieldErrors?.email}
        />
        <TextField
          label="Display name"
          required
          value={displayName}
          onChange={(event) => setDisplayName(event.currentTarget.value)}
          error={failure?.fieldErrors?.display_name}
        />
        <GrantFields
          stores={stores}
          objectType={objectType}
          setObjectType={setObjectType}
          objectId={objectId}
          setObjectId={setObjectId}
          relation={relation}
          setRelation={setRelation}
          allowNone
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Inviting…' : 'Invite'}
      </Button>
    </form>
  );
}

/** `assignRole` for one user: a relation the model can grant, on the organization or a store. */
export function AssignRoleForm({
  userId,
  organizationId,
  stores,
}: {
  userId: string;
  organizationId: string;
  stores: readonly StoreOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [objectType, setObjectType] = useState<ObjectType | ''>('store');
  const [objectId, setObjectId] = useState(stores[0]?.id ?? '');
  const [relation, setRelation] = useState<string>(GRANTABLE.store[0] ?? '');
  const [failure, setFailure] = useState<Failure | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (objectType === '') return;
    setFailure(null);
    startTransition(async () => {
      const result = await assignRoleAction(userId, {
        relation: relation as (typeof GRANTABLE)['organization'][number],
        object_type: objectType,
        object_id: objectType === 'organization' ? organizationId : objectId,
      });
      if (result.status === 'success') {
        router.refresh();
        return;
      }
      setFailure({ message: result.formError, refusal: result.refusal });
    });
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      className="border-line space-y-3 border-t pt-3"
      aria-label="Assign a relation"
    >
      <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
      <div className="grid gap-3 sm:grid-cols-3">
        <GrantFields
          stores={stores}
          objectType={objectType}
          setObjectType={setObjectType}
          objectId={objectId}
          setObjectId={setObjectId}
          relation={relation}
          setRelation={setRelation}
          allowNone={false}
        />
      </div>
      <p className="text-muted text-xs">Assigning ends this person’s current sessions.</p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? 'Assigning…' : 'Assign'}
      </Button>
    </form>
  );
}

/** `revokeRole`, after a question: it ends the person's sessions and cannot be undone here. */
export function RevokeAssignmentButton({
  userId,
  assignmentId,
  label,
}: {
  userId: string;
  assignmentId: string;
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  if (!asking) {
    return (
      <Button
        size="sm"
        variant="secondary"
        aria-label={`Revoke ${label}`}
        onClick={() => setAsking(true)}
      >
        Revoke
      </Button>
    );
  }
  return (
    <div
      role="alertdialog"
      aria-label={`Confirm revoking ${label}`}
      className="border-warning/30 bg-warning/5 basis-full space-y-2 rounded-md border px-3 py-2"
    >
      <p className="text-sm">
        Revoke <span className="font-medium">{label}</span>? This ends the person’s current
        sessions.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await revokeRoleAction(userId, assignmentId);
              if (result.status === 'success') {
                setAsking(false);
                router.refresh();
                return;
              }
              setFailure({ message: result.formError, refusal: result.refusal });
            })
          }
        >
          {pending ? 'Revoking…' : 'Yes, revoke'}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </div>
      <ActionRefusal refusal={failure?.refusal} message={failure?.message ?? null} />
    </div>
  );
}

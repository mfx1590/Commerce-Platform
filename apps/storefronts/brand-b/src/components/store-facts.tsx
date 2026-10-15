import { Card } from '@platform/ui';

export interface StoreFact {
  label: string;
  value: string;
  /** A second line under the value, e.g. which of several currencies is the default. */
  hint?: string | undefined;
}

/**
 * The home page's store facts, as a description list of cards.
 *
 * HTML allows exactly **one** wrapper between a `<dl>` and its terms (`dl > div > dt/dd`), so each
 * card is a single element: `Card` with its own padding, and no `CardContent` inside it. With both,
 * the chain was `dl > div > div > dt`, which detaches every term from the list — axe's `dlitem` and
 * `definition-list`, both serious (#286). `test/store-facts.test.ts` asserts the rendered structure.
 */
export function StoreFacts({ facts }: { facts: readonly StoreFact[] }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {facts.map((fact) => (
        <Card key={fact.label} className="p-4">
          <dt className="text-sm text-muted-foreground">{fact.label}</dt>
          <dd className="mt-1 text-lg font-medium">{fact.value}</dd>
          {fact.hint === undefined ? null : (
            <dd className="text-sm text-muted-foreground">{fact.hint}</dd>
          )}
        </Card>
      ))}
    </dl>
  );
}

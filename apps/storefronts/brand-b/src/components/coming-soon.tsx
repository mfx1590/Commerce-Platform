import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@platform/ui';

/**
 * Placeholder for a route that exists so the navigation is complete, but whose content belongs to a
 * later task. Each one names the task that replaces it.
 */
export function ComingSoon({ title, task }: { title: string; task: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>Arrives with {task}.</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        The route, its layout and the typed Store API client are in place; only this page&apos;s
        content is still to come.
      </CardContent>
    </Card>
  );
}

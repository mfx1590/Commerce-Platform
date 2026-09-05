import { Card, CardBody, CardHeader } from '@/components/ui/card';

/**
 * Every section exists and is reachable from task 1.2 onward; the screens themselves arrive with
 * their own issues. Saying which issue owns a section beats an empty page, and keeps the
 * "no blank pages" rule true from the start.
 */
export function SectionPlaceholder({
  title,
  delivers,
  description,
}: {
  title: string;
  delivers: string;
  description: string;
}) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <CardBody>
        <p className="text-muted text-sm">
          You can reach this section, so your relations allow it. The screen itself is delivered by{' '}
          {delivers}.
        </p>
      </CardBody>
    </Card>
  );
}

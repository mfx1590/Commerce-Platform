import { HqSectionGuard } from '@/components/shell/section-guard';
import { SectionPlaceholder } from '@/components/shell/section-placeholder';

export default function RolesPage() {
  return (
    <HqSectionGuard id="roles">
      <SectionPlaceholder
        title="Roles"
        delivers="window 2 in Phase 3"
        description="Staff users and their relations on the organization and on stores."
      />
    </HqSectionGuard>
  );
}

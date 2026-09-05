import { HqSectionGuard } from '@/components/shell/section-guard';
import { SectionPlaceholder } from '@/components/shell/section-placeholder';

export default function BiPage() {
  return (
    <HqSectionGuard id="bi">
      <SectionPlaceholder
        title="BI"
        delivers="window 12 in Phase 3"
        description="Embedded reporting across every store."
      />
    </HqSectionGuard>
  );
}

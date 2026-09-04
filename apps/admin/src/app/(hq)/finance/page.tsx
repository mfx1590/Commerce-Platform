import { HqSectionGuard } from '@/components/shell/section-guard';
import { SectionPlaceholder } from '@/components/shell/section-placeholder';

export default function FinancePage() {
  return (
    <HqSectionGuard id="finance">
      <SectionPlaceholder
        title="Finance"
        delivers="window 15 in Phase 4"
        description="Legal entities, the ledger and payout reconciliation."
      />
    </HqSectionGuard>
  );
}

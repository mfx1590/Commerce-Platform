import { HqSectionGuard } from '@/components/shell/section-guard';
import { SectionPlaceholder } from '@/components/shell/section-placeholder';

export default function WarehousePage() {
  return (
    <HqSectionGuard id="warehouse">
      <SectionPlaceholder
        title="Warehouse"
        delivers="window 11 in Phase 3"
        description="Shared stock pool across brands, warehouses and stock movements."
      />
    </HqSectionGuard>
  );
}

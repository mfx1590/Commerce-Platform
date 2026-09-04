import { HqSectionGuard } from '@/components/shell/section-guard';
import { SectionPlaceholder } from '@/components/shell/section-placeholder';

export default function StoresPage() {
  return (
    <HqSectionGuard id="stores">
      <SectionPlaceholder
        title="Stores"
        delivers="issue #28"
        description="Every store in the organization: create, edit, domains, sales channels and API keys."
      />
    </HqSectionGuard>
  );
}

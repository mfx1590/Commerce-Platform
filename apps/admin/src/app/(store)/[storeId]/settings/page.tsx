import { StoreSectionGuard } from '@/components/shell/section-guard';
import { SectionPlaceholder } from '@/components/shell/section-placeholder';

export default async function SettingsPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  return (
    <StoreSectionGuard storeId={storeId} id="settings">
      <SectionPlaceholder
        title="Settings"
        delivers="window 4 in Phase 2"
        description="Currencies, locales, sales channels, API keys and store defaults."
      />
    </StoreSectionGuard>
  );
}

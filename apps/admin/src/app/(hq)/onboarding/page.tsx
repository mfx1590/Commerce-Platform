import { HqSectionGuard } from '@/components/shell/section-guard';
import { SectionPlaceholder } from '@/components/shell/section-placeholder';

export default function OnboardingPage() {
  return (
    <HqSectionGuard id="onboarding">
      <SectionPlaceholder
        title="Onboarding"
        delivers="window 2 in Phase 3"
        description="The wizard that takes a new brand from legal entity to live storefront."
      />
    </HqSectionGuard>
  );
}

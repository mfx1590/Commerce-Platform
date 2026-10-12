import { SANITY_API_VERSION } from '@platform/cms';

/**
 * CMS configuration, read from the environment on the server only. Every value is optional: a
 * storefront without Sanity credentials still builds and renders (the reader returns empty
 * content and warns once), which is also what CI does.
 */
export interface CmsConfig {
  /** `SANITY_PROJECT_ID`; `null` means "no CMS" */
  projectId: string | null;
  apiVersion: string;
  /** `SANITY_READ_TOKEN`; needed only to read drafts in preview mode */
  readToken: string | null;
  /** `SANITY_PREVIEW_SECRET`; signs the preview cookie and gates `/api/cms/preview` */
  previewSecret: string | null;
  /** `SANITY_WEBHOOK_SECRET`; verifies `/api/cms/revalidate` */
  webhookSecret: string | null;
}

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

export function cmsConfigFromEnv(env: Record<string, string | undefined> = process.env): CmsConfig {
  if (typeof window !== 'undefined') {
    throw new Error('The CMS client is server-only; call it from a server component or a route');
  }
  return {
    projectId: optional(env.SANITY_PROJECT_ID),
    apiVersion: optional(env.SANITY_API_VERSION) ?? SANITY_API_VERSION,
    readToken: optional(env.SANITY_READ_TOKEN),
    previewSecret: optional(env.SANITY_PREVIEW_SECRET),
    webhookSecret: optional(env.SANITY_WEBHOOK_SECRET),
  };
}

export function isCmsConfigured(config: CmsConfig): config is CmsConfig & { projectId: string } {
  return config.projectId !== null;
}

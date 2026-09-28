import { apiMode, versionVerdict, type ApiModeInfo } from '@/lib/api/api-mode';
import { env } from '@/lib/env';

/**
 * Which Admin API this page came from (#118): a quiet chip when all is well, a warning line when
 * the core speaks another contracts version, does not say which, or did not answer. It informs and
 * never blocks — the page renders underneath either way.
 */
export function ApiModeNotice({ info }: { info: ApiModeInfo }) {
  const verdict = versionVerdict(info);
  if (verdict.tone === 'ok') {
    return (
      <p className="text-muted mb-4 text-xs" data-api-mode={info.mode}>
        <span className="border-line rounded-full border px-2 py-0.5 font-mono">
          {verdict.text}
        </span>
      </p>
    );
  }
  return (
    <div
      role="status"
      data-api-mode={info.mode}
      className="border-warning/30 bg-warning/5 mb-4 rounded-md border px-4 py-2 text-sm"
    >
      {verdict.text}
    </div>
  );
}

export async function ApiModeBanner() {
  return <ApiModeNotice info={await apiMode(env.adminApiUrl)} />;
}

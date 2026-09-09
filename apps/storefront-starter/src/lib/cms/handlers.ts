import type { CmsConfig } from './config';
import {
  PREVIEW_COOKIE,
  PREVIEW_MAX_AGE_SECONDS,
  safeRedirectPath,
  secretsMatch,
  serializeCookie,
  signPreviewToken,
} from './preview';
import {
  parseWebhookPayload,
  SIGNATURE_HEADER,
  tagsForWebhook,
  verifyWebhookSignature,
} from './revalidate';

/**
 * The route handlers as pure `Request → Response` functions. `src/app/api/cms/<name>/route.ts` mounts
 * them with the real environment, `revalidateTag` and the store's dataset; the tests call them
 * with fakes. No `next/*` import here on purpose.
 */

export interface PreviewDeps {
  config: CmsConfig;
  /** The store's dataset, or `null` when the store could not be resolved. */
  dataset: string | null;
  secure: boolean;
  now?: () => number;
}

/**
 * `GET /api/cms/preview?secret=<SANITY_PREVIEW_SECRET>&redirect=/en-GB/pages/about`
 * Sets the preview cookie and redirects. 503 without a preview secret or read token (there is
 * nothing to preview with), 401 on a wrong secret, and only same-site redirect targets.
 */
export function handlePreview(request: Request, deps: PreviewDeps): Response {
  const { config } = deps;
  if (!config.previewSecret || !config.readToken || !deps.dataset) {
    return Response.json({ error: 'preview_unavailable' }, { status: 503 });
  }
  const url = new URL(request.url);
  if (!secretsMatch(config.previewSecret, url.searchParams.get('secret'))) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const now = deps.now?.() ?? Date.now();
  const token = signPreviewToken(
    config.previewSecret,
    deps.dataset,
    now + PREVIEW_MAX_AGE_SECONDS * 1000,
  );
  return redirect(url, safeRedirectPath(url.searchParams.get('redirect')), {
    'set-cookie': serializeCookie(PREVIEW_COOKIE, token, {
      maxAge: PREVIEW_MAX_AGE_SECONDS,
      secure: deps.secure,
    }),
  });
}

/** `GET /api/cms/preview/exit?redirect=/` — clears the cookie. */
export function handlePreviewExit(request: Request, deps: Pick<PreviewDeps, 'secure'>): Response {
  const url = new URL(request.url);
  return redirect(url, safeRedirectPath(url.searchParams.get('redirect')), {
    'set-cookie': serializeCookie(PREVIEW_COOKIE, '', { maxAge: 0, secure: deps.secure }),
  });
}

function redirect(base: URL, path: string, headers: Record<string, string>): Response {
  return new Response(null, {
    status: 307,
    headers: { location: new URL(path, base.origin).toString(), ...headers },
  });
}

export interface RevalidateDeps {
  config: CmsConfig;
  revalidateTag: (tag: string) => void;
  now?: () => number;
}

/**
 * `POST /api/cms/revalidate` — Sanity's publish webhook. 503 without a webhook secret (an
 * unverifiable webhook is refused, never trusted), 401 on a bad or stale signature, 400 on a body
 * that is not JSON; otherwise revalidates the tags for the document and reports them.
 */
export async function handleRevalidate(request: Request, deps: RevalidateDeps): Promise<Response> {
  const secret = deps.config.webhookSecret;
  if (!secret) return Response.json({ error: 'webhook_unavailable' }, { status: 503 });

  const body = await request.text();
  const verdict = verifyWebhookSignature(
    secret,
    request.headers.get(SIGNATURE_HEADER),
    body,
    deps.now?.() ?? Date.now(),
  );
  if (!verdict.ok) {
    return Response.json({ error: 'invalid_signature', reason: verdict.reason }, { status: 401 });
  }

  const payload = parseWebhookPayload(body);
  if (payload === null) return Response.json({ error: 'invalid_payload' }, { status: 400 });

  const tags = tagsForWebhook(payload);
  for (const tag of tags) deps.revalidateTag(tag);
  return Response.json({ revalidated: tags }, { status: 200 });
}

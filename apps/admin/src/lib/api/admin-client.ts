/**
 * Transport for the Admin API (`packages/contracts/openapi/admin-api.yaml`, contracts-v0.4.5).
 *
 * Nothing here throws on an HTTP error status. Every call resolves to a discriminated result so the
 * shared 401 / 403 / 404 / empty / error panels can render in place instead of blowing up a route.
 * This module is intentionally free of `next/*` imports so it can be unit-tested with a stub fetch.
 */

import type { components, operations } from '@platform/contracts/admin';

export type AdminComponents = components['schemas'];
export type AdminError = AdminComponents['Error'];

/** The JSON body of an operation's success response (200, else 201, else 202, else 204 → null). */
type SuccessBody<O> = O extends { responses: infer R }
  ? R extends { 200: { content: { 'application/json': infer T } } }
    ? T
    : R extends { 201: { content: { 'application/json': infer T } } }
      ? T
      : // 202 Accepted with a body (REQUEST #251): `materializeSegment` answers with the Segment whose
        // refresh was queued, `eraseCustomer` is the other. Without this branch they typed as `null` —
        // silently, because the fall-through is a valid type rather than an error.
        R extends { 202: { content: { 'application/json': infer T } } }
        ? T
        : null
  : never;

export type AdminResponse<K extends keyof operations> = SuccessBody<operations[K]>;

export type ApiResult<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; error: AdminError };

export type QueryValue = string | number | boolean | undefined;

export interface AdminRequestOptions {
  baseUrl: string;
  path: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  accessToken?: string | undefined;
  query?: Record<string, QueryValue> | undefined;
  body?: unknown;
  /** Prism honours `Prefer: code=403`, which is how the error-state tests drive the mock. */
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** Substitutes `{param}` placeholders in a contract path template. */
export function buildPath(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing path parameter "${key}" for ${template}`);
    }
    return encodeURIComponent(String(value));
  });
}

function applyQuery(url: URL, query: Record<string, QueryValue> | undefined): void {
  if (query === undefined) return;
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
}

/** Anything that is not a contract `Error` body still has to reach the UI as one. */
function coerceError(status: number, payload: unknown, fallbackMessage: string): AdminError {
  if (typeof payload === 'object' && payload !== null) {
    const candidate = payload as Partial<AdminError>;
    if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
      return candidate as AdminError;
    }
  }
  return { code: status >= 500 ? 'internal' : 'unknown', message: fallbackMessage };
}

export async function adminRequest<K extends keyof operations>(
  options: AdminRequestOptions,
): Promise<ApiResult<AdminResponse<K>>> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = new URL(`${options.baseUrl}${options.path}`);
  applyQuery(url, options.query);

  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (options.accessToken !== undefined && options.accessToken !== '') {
    headers['authorization'] = `Bearer ${options.accessToken}`;
  }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await doFetch(url.toString(), {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      cache: 'no-store',
    });
  } catch (cause) {
    // DNS failure, connection refused, abort: the retry panel, not a crash.
    return {
      ok: false,
      status: 0,
      error: {
        code: 'network_error',
        message: cause instanceof Error ? cause.message : 'Request failed',
      },
    };
  }

  const raw = await response.text();
  let payload: unknown = null;
  if (raw !== '') {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: coerceError(response.status, payload, response.statusText || 'Request failed'),
    };
  }

  return { ok: true, status: response.status, data: payload as AdminResponse<K> };
}

import { CONTRACTS_VERSION } from '@platform/contracts';

/**
 * Which Admin API the app is talking to, and which contracts version it speaks (#118).
 *
 * The core answers `GET /health` with 200; Prism has no such path in the spec and answers 404.
 * That difference is the ground truth — not the env variable's name, which the e2e config and a
 * developer's `.env` both rewrite. The core's contracts version arrives as `X-Contracts-Version`
 * on `/health` once REQUEST #284 lands; until then it is unknown, which is a warning, never a
 * block.
 */

export type ApiMode = 'core' | 'mock' | 'unreachable';

export interface ApiModeInfo {
  mode: ApiMode;
  /** The core's `X-Contracts-Version`, or null when it did not send one (or is not the core). */
  contractsVersion: string | null;
}

export const PROBE_TIMEOUT_MS = 1_500;
export const PROBE_TTL_MS = 60_000;

export async function probeApiMode(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiModeInfo> {
  try {
    const response = await fetchImpl(new URL('/health', baseUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      return { mode: 'core', contractsVersion: response.headers.get('x-contracts-version') };
    }
    // Only Prism's 404 means the mock. A core answering 500 (or anything else) on `/health` is a
    // core in trouble, not a mock — calling it the mock would hide the not-implemented mapping.
    if (response.status === 404) return { mode: 'mock', contractsVersion: null };
    return { mode: 'unreachable', contractsVersion: null };
  } catch {
    return { mode: 'unreachable', contractsVersion: null };
  }
}

let cached: { baseUrl: string; at: number; info: Promise<ApiModeInfo> } | null = null;

/** `probeApiMode`, at most once a minute per API base URL for the whole server process. */
export function apiMode(baseUrl: string, now = Date.now()): Promise<ApiModeInfo> {
  if (cached !== null && cached.baseUrl === baseUrl && now - cached.at < PROBE_TTL_MS) {
    return cached.info;
  }
  const info = probeApiMode(baseUrl);
  cached = { baseUrl, at: now, info };
  return info;
}

/** For tests: forget the cached probe. */
export function resetApiModeCache(): void {
  cached = null;
}

export type VersionVerdict = { tone: 'ok'; text: string } | { tone: 'warning'; text: string };

/** What the banner says. Only a matching core, or the mock, is quiet; nothing ever blocks. */
export function versionVerdict(
  info: ApiModeInfo,
  appVersion: string = CONTRACTS_VERSION,
): VersionVerdict {
  if (info.mode === 'mock') return { tone: 'ok', text: `Prism mock · contracts ${appVersion}` };
  if (info.mode === 'unreachable') {
    return {
      tone: 'warning',
      text: 'The Admin API did not answer its health check. Screens may show errors until it is back.',
    };
  }
  if (info.contractsVersion === null) {
    return {
      tone: 'warning',
      text: `Core · contracts version unknown (this app speaks ${appVersion}). The core does not report its version yet.`,
    };
  }
  if (info.contractsVersion !== appVersion) {
    return {
      tone: 'warning',
      text: `Core speaks contracts ${info.contractsVersion}; this app was built for ${appVersion}. Some screens may disagree with the core.`,
    };
  }
  return { tone: 'ok', text: `Core · contracts ${appVersion}` };
}

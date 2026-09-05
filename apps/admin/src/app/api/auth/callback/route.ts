/**
 * Finishes the OIDC flow: validates `state`, redeems the code with the stored PKCE verifier and
 * seals the resulting token set into the session cookie. Tokens are never sent to the browser as
 * readable values — the cookie is httpOnly and AES-GCM encrypted.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { env, isProduction, redirectUri, sessionSecret } from '@/lib/env';
import { exchangeCode } from '@/lib/auth/oidc';
import { sealSession, writeSessionCookies } from '@/lib/auth/session';
import {
  OIDC_RETURN_TO_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_TRANSIENT_COOKIES,
  OIDC_VERIFIER_COOKIE,
} from '@/lib/auth/oidc-cookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function failure(reason: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/auth/error?reason=${encodeURIComponent(reason)}`, env.appUrl),
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;

  const providerError = params.get('error');
  if (providerError !== null) {
    return failure(params.get('error_description') ?? providerError);
  }

  const code = params.get('code');
  const state = params.get('state');
  const expectedState = request.cookies.get(OIDC_STATE_COOKIE)?.value;
  const verifier = request.cookies.get(OIDC_VERIFIER_COOKIE)?.value;

  if (code === null || state === null || expectedState === undefined || verifier === undefined) {
    return failure('The sign-in link expired. Please try again.');
  }
  if (state !== expectedState) {
    return failure('Sign-in state did not match. Please try again.');
  }

  let sealed: string;
  try {
    const session = await exchangeCode(code, verifier, redirectUri());
    sealed = await sealSession(session, sessionSecret());
  } catch (cause) {
    return failure(cause instanceof Error ? cause.message : 'Could not complete sign-in');
  }

  const returnTo = request.cookies.get(OIDC_RETURN_TO_COOKIE)?.value ?? '/';
  const response = NextResponse.redirect(new URL(returnTo, env.appUrl));
  writeSessionCookies(response.cookies, sealed, isProduction);
  for (const name of OIDC_TRANSIENT_COOKIES) {
    response.cookies.delete(name);
  }
  return response;
}

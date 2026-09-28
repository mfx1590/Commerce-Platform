import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, keycloakOrigin } from '@/lib/csp';

/**
 * The storefront CSP. Every failure mode here is silent — a blocked sign-out, a blocked embed, or a
 * policy the browser drops entirely — so each directive that has caused or could cause one is pinned.
 */

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split(';').map((part) => {
      const [name = '', ...values] = part.trim().split(/\s+/);
      return [name, values.join(' ')];
    }),
  );
}

const FRAMES = 'https://builder.io https://*.framer.app';

describe('form-action', () => {
  it('allows the deployment’s own identity provider, so sign-out can end the SSO session', () => {
    // Chrome checks form-action against the URL after redirects; sign-out answers 303 to Keycloak.
    const policy = contentSecurityPolicy({
      keycloakUrl: 'https://auth.staging.example.com/realms/customers',
      frameHosts: FRAMES,
    });
    expect(directives(policy).get('form-action')).toBe("'self' https://auth.staging.example.com");
  });

  it('follows the value it is given — the whole point of building it per request', () => {
    // One image, many environments: dev and staging must each get their own provider.
    const dev = contentSecurityPolicy({
      keycloakUrl: 'https://auth.dev.example.com',
      frameHosts: '',
    });
    const staging = contentSecurityPolicy({
      keycloakUrl: 'https://auth.staging.example.com',
      frameHosts: '',
    });
    expect(directives(dev).get('form-action')).toContain('auth.dev.example.com');
    expect(directives(staging).get('form-action')).toContain('auth.staging.example.com');
  });

  it('falls back to the local default rather than emitting a directive the browser would reject', () => {
    expect(keycloakOrigin(undefined)).toBe('http://localhost:8180');
    expect(keycloakOrigin('not a url')).toBe('http://localhost:8180');
    expect(keycloakOrigin('https://auth.example.com:8443/realms/x')).toBe(
      'https://auth.example.com:8443',
    );
  });
});

describe('frame-src', () => {
  it('lists the campaign embed hosts it is given', () => {
    const policy = contentSecurityPolicy({ keycloakUrl: undefined, frameHosts: FRAMES });
    expect(directives(policy).get('frame-src')).toBe(
      "'self' https://builder.io https://*.framer.app",
    );
  });

  it('drops anything that is not an https host, so a malformed list cannot widen the policy', () => {
    const policy = contentSecurityPolicy({
      keycloakUrl: undefined,
      frameHosts: "https://builder.io http://plain.example * 'unsafe-inline'",
    });
    expect(directives(policy).get('frame-src')).toBe("'self' https://builder.io");
  });

  it('still frames only ourselves when no embed hosts are configured', () => {
    expect(
      directives(contentSecurityPolicy({ keycloakUrl: undefined, frameHosts: undefined })).get(
        'frame-src',
      ),
    ).toBe("'self'");
  });
});

describe('the fixed directives', () => {
  const policy = directives(contentSecurityPolicy({ keycloakUrl: undefined, frameHosts: FRAMES }));

  it('forbids framing us — clickjacking a checkout', () => {
    expect(policy.get('frame-ancestors')).toBe("'none'");
  });

  it('forbids plugins and base-URI hijacking', () => {
    expect(policy.get('object-src')).toBe("'none'");
    expect(policy.get('base-uri')).toBe("'self'");
  });

  it('keeps the browser talking only to this origin', () => {
    expect(policy.get('connect-src')).toBe("'self'");
    expect(policy.get('default-src')).toBe("'self'");
  });
});

import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { config } from '../config.js';

/** gatehouse(사내 SSO) OIDC. OIDC_* 3종이 다 있을 때만 켜진다. */

let provider: oidc.Configuration | null = null;

export function oidcEnabled() {
  return config.oidc.enabled;
}

export async function initOidc() {
  if (!oidcEnabled()) return;
  const issuerUrl = new URL(config.oidc.issuer);
  provider = await oidc.discovery(
    issuerUrl,
    config.oidc.clientId,
    config.oidc.clientSecret,
    undefined,
    // openid-client는 https를 요구한다 — 로컬 개발용으로만 완화.
    issuerUrl.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : undefined
  );
}

export function cliClientId() {
  return config.oidc.cliClientId;
}

let jwks: JWTVerifyGetKey | null = null;

/**
 * CLI 가 device flow 로 받아 온 id_token 을 검증한다.
 * 서명(JWKS)·발급자·대상(CLI 클라이언트 id)을 모두 확인해야 한다 — 셋 중 하나라도
 * 빼면 다른 클라이언트용 토큰을 그대로 들고 와 로그인할 수 있다.
 */
export async function verifyCliIdToken(idToken: string): Promise<OidcIdentity> {
  if (!provider) throw new Error('SSO가 설정되지 않았습니다.');
  if (!jwks) {
    const uri = provider.serverMetadata().jwks_uri;
    if (!uri) throw new Error('IdP 메타데이터에 jwks_uri 가 없습니다.');
    jwks = createRemoteJWKSet(new URL(uri));
  }
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: provider.serverMetadata().issuer,
    audience: config.oidc.cliClientId,
  });
  return identityFromClaims(payload);
}

export function redirectUri() {
  return `${config.adminUrl}/api/auth/oidc/callback`;
}

export interface OidcStart {
  url: string;
  state: string;
  codeVerifier: string;
}

export async function buildAuthUrl(): Promise<OidcStart> {
  if (!provider) throw new Error('oidc not initialized');
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();
  const url = oidc.buildAuthorizationUrl(provider, {
    redirect_uri: redirectUri(),
    scope: 'openid email profile',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });
  return { url: url.href, state, codeVerifier };
}

export interface OidcIdentity {
  email: string;
  name: string;
}

export async function handleCallback(
  currentUrl: URL,
  state: string,
  codeVerifier: string
): Promise<OidcIdentity> {
  if (!provider) throw new Error('oidc not initialized');
  const tokens = await oidc.authorizationCodeGrant(provider, currentUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState: state,
  });
  return identityFromClaims(tokens.claims() ?? {});
}

/**
 * ID 토큰 클레임에서 신원을 꺼낸다. 웹 로그인과 CLI 로그인이 같은 기준을 쓴다.
 *
 * 우리는 이메일로 사용자를 찾는다. IdP 가 "이 이메일은 확인됐다"고 말해 주지 않으면
 * (email_verified 가 true 가 아니면) 남의 주소를 적어 넣은 계정으로 그 사람이 될 수 있다.
 */
export function identityFromClaims(claims: Record<string, unknown>): OidcIdentity {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) throw new Error('ID 토큰에 email 클레임이 없습니다.');
  if (claims.email_verified !== true) throw new Error('확인되지 않은 이메일입니다(email_verified).');
  return { email, name: typeof claims.name === 'string' && claims.name ? claims.name : email };
}

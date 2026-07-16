import { createHmac, timingSafeEqual } from "node:crypto";
import type { PlayerKind } from "@onestepchess/core";

export type SessionClaims = {
  readonly sub: string;
  readonly kind: PlayerKind;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
};

// HS256 JWT with an injectable clock — expiry must follow the server's time
// source, not the wall clock a test cannot control.

function hmac(secret: string, signingInput: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

export function signSession(secret: string, claims: SessionClaims): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = hmac(secret, `${header}.${payload}`).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifySessionToken(
  secret: string,
  token: string,
  nowMs: number,
): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts as [string, string, string];
  const expected = hmac(secret, `${header}.${payload}`);
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }
  let decodedHeader: { alg?: string };
  let claims: SessionClaims;
  try {
    decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString());
    claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (decodedHeader.alg !== "HS256") {
    return null;
  }
  if (
    typeof claims.sub !== "string" ||
    typeof claims.jti !== "string" ||
    typeof claims.exp !== "number" ||
    (claims.kind !== "human" &&
      claims.kind !== "agent" &&
      claims.kind !== "guest")
  ) {
    return null;
  }
  if (claims.exp * 1_000 <= nowMs) {
    return null;
  }
  return claims;
}

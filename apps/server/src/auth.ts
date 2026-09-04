import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string): Buffer =>
  createHash('sha256').update(value, 'utf8').digest();

export const constantTimeTokenEqual = (expected: string, candidate: string): boolean =>
  timingSafeEqual(digest(expected), digest(candidate));

const bearerCandidate = (authorization: string | undefined): string | undefined => {
  if (authorization === undefined || authorization.includes('\r') || authorization.includes('\n')) {
    return undefined;
  }
  const match = authorization.match(/^Bearer ([^\s]+)$/iu);
  return match?.[1];
};

export const hasValidBearer = (
  authorization: string | undefined,
  expectedToken: string | undefined,
): boolean => {
  if (expectedToken === undefined) return true;
  const candidate = bearerCandidate(authorization) ?? '';
  return constantTimeTokenEqual(expectedToken, candidate) && candidate !== '';
};

export const isAllowedOrigin = (
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean => origin !== undefined && origin !== 'null' && allowedOrigins.includes(origin);

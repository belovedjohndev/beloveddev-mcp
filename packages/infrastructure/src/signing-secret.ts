/** Reject obvious weak configuration; only a CSPRNG can establish key entropy. */
export function isValidCursorSecret(secret: string): boolean {
  if (
    secret.length < 32 ||
    Buffer.byteLength(secret, 'utf8') > 1024 ||
    /[\s\p{C}]/u.test(secret) ||
    new Set(secret).size < 8 ||
    /change[-_]?me|replace[-_]|placeholder|example|your[-_](?:secret|key)|do[-_]not[-_]use/i.test(
      secret,
    )
  ) {
    return false;
  }
  for (let period = 1; period <= Math.min(32, secret.length / 2); period += 1) {
    if (
      secret.length % period === 0 &&
      secret === secret.slice(0, period).repeat(secret.length / period)
    ) {
      return false;
    }
  }
  return true;
}

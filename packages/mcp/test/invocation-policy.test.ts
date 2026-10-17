import { describe, expect, it, vi } from 'vitest';
import { ApplicationError } from '@beloveddev/application/application-error';
import { InvocationAdmission, MAX_ACTIVE_INVOCATIONS } from '../src/invocation-policy.js';

describe('process invocation admission', () => {
  it('releases a lease only once and immediately reuses exactly one slot', () => {
    const admission = new InvocationAdmission();
    const releases = Array.from({ length: MAX_ACTIVE_INVOCATIONS }, () => admission.enter());
    expect(() => admission.enter()).toThrow(new ApplicationError('RATE_LIMITED'));
    releases[0]?.();
    releases[0]?.();
    const next = admission.enter();
    expect(() => admission.enter()).toThrow(new ApplicationError('RATE_LIMITED'));
    next();
    for (const release of releases) release();
  });

  it('preserves shutdown refusal even at capacity without releasing existing work', () => {
    let stopping = false;
    const release = vi.fn();
    const admission = new InvocationAdmission({ enter: () => (stopping ? null : release) });
    const leases = Array.from({ length: MAX_ACTIVE_INVOCATIONS }, () => admission.enter());
    stopping = true;
    expect(() => admission.enter()).toThrow(new ApplicationError('INTERNAL_ERROR'));
    expect(release).not.toHaveBeenCalled();
    for (const lease of leases) lease();
    expect(release).toHaveBeenCalledTimes(MAX_ACTIVE_INVOCATIONS);
  });
});

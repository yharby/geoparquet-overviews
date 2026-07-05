import { describe, it, expect } from 'vitest';
import { planSignature } from './plan-signature';
import type { RowGroupRange } from './rowgroups';

const rg = (index: number, subRanges?: { rowStart: number; rowEnd: number }[]): RowGroupRange => ({
  index,
  rowStart: 0,
  rowEnd: 100,
  subRanges,
});

describe('planSignature', () => {
  it('is independent of range order', () => {
    const a = planSignature('geometry', [rg(1), rg(2), rg(3)]);
    const b = planSignature('geometry', [rg(3), rg(1), rg(2)]);
    expect(a).toBe(b);
  });

  it('changes when the column changes', () => {
    expect(planSignature('geometry', [rg(1)])).not.toBe(planSignature('geom_overview', [rg(1)]));
  });

  it('changes when a group is added or removed', () => {
    expect(planSignature('geometry', [rg(1), rg(2)])).not.toBe(planSignature('geometry', [rg(1)]));
  });

  it('distinguishes a page-pruned sub-range set from a whole-group read', () => {
    const whole = planSignature('geometry', [rg(1)]);
    const pruned = planSignature('geometry', [rg(1, [{ rowStart: 10, rowEnd: 20 }])]);
    expect(whole).not.toBe(pruned);
  });

  it('changes when sub-range boundaries shift', () => {
    const a = planSignature('geometry', [rg(1, [{ rowStart: 10, rowEnd: 20 }])]);
    const b = planSignature('geometry', [rg(1, [{ rowStart: 12, rowEnd: 22 }])]);
    expect(a).not.toBe(b);
  });
});

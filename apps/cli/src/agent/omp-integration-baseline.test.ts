import { describe, expect, it } from 'vitest';
import {
  evaluateOmpIntegrationBaseline,
  OMP_BASELINE_RELEASE,
  OMP_INTEGRATION_FEATURES,
  type OmpBaselineCheck,
} from './omp-integration-baseline';

describe('OMP full-feature baseline gate', () => {
  const evidence = (): OmpBaselineCheck => ({
    status: 'verified',
    evidence: 'native-runtime-assertion',
  });
  const checksFor = (count: number) =>
    Object.fromEntries(
      OMP_INTEGRATION_FEATURES.slice(0, count).flatMap(({ checks }) =>
        checks.map((id) => [id, evidence()])
      )
    );

  it('keeps every unknown feature in the denominator', () => {
    const result = evaluateOmpIntegrationBaseline(OMP_BASELINE_RELEASE, {
      'read-file': evidence(),
    });
    expect(result.totalFeatures).toBe(36);
    expect(result.verifiedFeatures).toBe(0);
    expect(result.coveragePercent).toBe(0);
    expect(result.passes).toBe(false);
    expect(result.features.find(({ id }) => id === 'hashline-edit')).toMatchObject({
      status: 'partial',
      missingChecks: ['write-file', 'edit-file', 'stale-edit-rejected'],
    });
  });

  it('requires all 36 families, including those beyond the earlier 80 percent target', () => {
    for (const count of [28, 29, 35]) {
      const result = evaluateOmpIntegrationBaseline(OMP_BASELINE_RELEASE, checksFor(count));
      expect(result.verifiedFeatures).toBe(count);
      expect(result.passes).toBe(false);
    }
    const result = evaluateOmpIntegrationBaseline(OMP_BASELINE_RELEASE, checksFor(36));
    expect(result.verifiedFeatures).toBe(36);
    expect(result.coveragePercent).toBe(100);
    expect(result.requiredCoveragePercent).toBe(100);
    expect(result.passes).toBe(true);
  });

  it('does not count an unsupported, failed, or evidence-free facet as completed', () => {
    for (const replacement of [
      { status: 'failed', evidence: 'native failure' },
      { status: 'unsupported', evidence: 'client rejected method' },
      { status: 'verified', evidence: '' },
    ] as OmpBaselineCheck[]) {
      const result = evaluateOmpIntegrationBaseline(OMP_BASELINE_RELEASE, {
        ...checksFor(36),
        'audio-output': replacement,
      });
      expect(result.verifiedFeatures).toBe(35);
      expect(result.passes).toBe(false);
    }
  });

  it('rejects an unrelated release and checks outside the frozen inventory', () => {
    expect(() => evaluateOmpIntegrationBaseline('18.1.13', {})).toThrow('release mismatch');
    expect(() =>
      evaluateOmpIntegrationBaseline(OMP_BASELINE_RELEASE, { invented: evidence() })
    ).toThrow('Unknown');
  });
});

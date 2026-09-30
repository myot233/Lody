/** Public OMP v18.4.3 feature inventory; changing the denominator requires review. */
export const OMP_BASELINE_RELEASE = '18.4.3';
export const OMP_BASELINE_SOURCE = 'fc671eba383f2a7208500836673b485c0dc7073d';
// The MCP prompt repair is a measured build; full acceptance requires every family.
export const OMP_BASELINE_MCP_PATCH_SHA256 =
  '304ef2486eb4c399b1716ec17e5a6db0aeb37f2489e6585dd6488fda01be5cd9';
export const OMP_BASELINE_MCP_BINARY_SHA256 =
  'c3a0d147bba28298b4bb92fb67b53f2ef158f0ffaf64de789fb95cd46ca1f8a6';
export const OMP_BASELINE_EXTENDED_PATCH_SHA256 =
  '993bb124dd4d2f28da8b04ce8aec4093f61b7dc4d4fdb6bd711e2401d473e360';
export const OMP_BASELINE_EXTENDED_BINARY_SHA256 =
  'bb4098983a1e1858f1cef5b20b037388fd8e6a69a7146ed31bf9b39d3d38f80a';
export const OMP_BASELINE_CORE_SOURCE = 'c80616271c52de79ab4502fd58901d1e72088b86';
export const OMP_BASELINE_CORE_PATCH_SHA256 =
  'b624c25c199711e37100df4409d2fe5eac27c78b687c7c6705f0286d83b9887c';
export const OMP_BASELINE_BINARY_SHA256 =
  '1339e8e98b82d3e2341d198b8e17fd8b56ded2a8d83bc76f8086a858aca7c347';

export const OMP_INTEGRATION_FEATURES = [
  { id: 'code-execution', checks: ['eval-python', 'eval-javascript', 'eval-tool-reentry'] },
  { id: 'lsp', checks: ['lsp-diagnostics', 'lsp-navigation', 'lsp-write'] },
  { id: 'debugger', checks: ['dap-session', 'dap-step', 'dap-variables'] },
  { id: 'stream-rules', checks: ['rule-discovery', 'stream-rule-injection'] },
  { id: 'subagents', checks: ['task-fanout', 'task-results', 'agent-url'] },
  { id: 'advisor', checks: ['advisor-note', 'advisor-controls'] },
  { id: 'collaboration', checks: ['collab-start', 'collab-share', 'collab-join'] },
  { id: 'web-documents-search', checks: ['web-search', 'read-url', 'read-pdf'] },
  { id: 'native-tools', checks: ['grep', 'glob', 'bash', 'terminal-output'] },
  { id: 'code-review', checks: ['review-run', 'review-verdict', 'review-findings'] },
  { id: 'hashline-edit', checks: ['read-file', 'write-file', 'edit-file', 'stale-edit-rejected'] },
  { id: 'github-paths', checks: ['read-pr', 'read-issue', 'github-tool'] },
  { id: 'memory', checks: ['retain', 'recall', 'learn', 'memory-edit'] },
  {
    id: 'acp-lifecycle',
    checks: [
      'initialize',
      'new-session',
      'prompt',
      'image-input',
      'embedded-context',
      'cancel',
      'close',
    ],
  },
  {
    id: 'configuration-discovery',
    checks: [
      'project-config',
      'instructions',
      'foreign-rules',
      'named-profile',
      'settings-persistence',
    ],
  },
  { id: 'atomic-commits', checks: ['commit-split', 'commit-validation'] },
  { id: 'internal-urls', checks: ['read-skill-url', 'read-session-url', 'xdev-tool'] },
  { id: 'merge-conflicts', checks: ['conflict-read', 'conflict-resolve'] },
  { id: 'staged-ast-edits', checks: ['ast-grep', 'ast-edit-preview', 'ast-edit-accept'] },
  { id: 'browser', checks: ['browser-open', 'browser-read', 'browser-interact'] },
  { id: 'desktop', checks: ['computer-windows', 'computer-screenshot', 'computer-input'] },
  {
    id: 'model-controls',
    checks: ['model-catalog', 'model-select', 'thinking-select', 'mode-select', 'provider-auth'],
  },
  { id: 'skills', checks: ['skill-discovery', 'skill-invoke', 'managed-skill'] },
  {
    id: 'extensions',
    checks: ['extension-command', 'extension-hook', 'extension-tool', 'extension-reload'],
  },
  {
    id: 'slash-commands',
    checks: ['command-discovery', 'builtin-command', 'file-command', 'command-arguments'],
  },
  {
    id: 'forms',
    checks: [
      'form-select',
      'form-confirm',
      'form-input',
      'form-editor',
      'form-single',
      'form-multi',
      'form-custom',
      'form-cancel',
    ],
  },
  {
    id: 'permissions-plans',
    checks: ['permission-allow', 'permission-deny', 'plan-proposal', 'plan-approve', 'todo-plan'],
  },
  { id: 'mcp', checks: ['mcp-stdio', 'mcp-http', 'mcp-prompts'] },
  { id: 'media', checks: ['image-output', 'audio-output', 'speech-models'] },
  { id: 'context-controls', checks: ['checkpoint', 'rewind', 'compact'] },
  { id: 'background-jobs', checks: ['job-start', 'job-output', 'job-cancel', 'steer'] },
  {
    id: 'saved-sessions',
    checks: ['session-load', 'session-resume', 'session-fork', 'session-history'],
  },
  { id: 'usage', checks: ['usage-tokens', 'usage-context', 'usage-cost'] },
  {
    id: 'native-management',
    checks: [
      'omp-session-list',
      'omp-project-list',
      'omp-chats',
      'omp-usage',
      'omp-extension-list',
      'omp-extension-toggle',
    ],
  },
  { id: 'tui-customization', checks: ['themes', 'keybindings', 'custom-widgets'] },
  { id: 'security-review', checks: ['security-scan-start', 'security-scan-results'] },
] as const;

export type OmpBaselineCheck = { status: 'verified' | 'failed' | 'unsupported'; evidence: string };

export function evaluateOmpIntegrationBaseline(
  release: string,
  checks: Record<string, OmpBaselineCheck>
) {
  if (release !== OMP_BASELINE_RELEASE) throw new Error('OMP baseline release mismatch');
  const knownChecks = new Set<string>(
    OMP_INTEGRATION_FEATURES.flatMap((feature) => [...feature.checks])
  );
  if (Object.keys(checks).some((id) => !knownChecks.has(id)))
    throw new Error('Unknown OMP baseline check');
  const features = OMP_INTEGRATION_FEATURES.map(({ id, checks: requiredChecks }) => {
    const verified = requiredChecks.filter(
      (check) => checks[check]?.status === 'verified' && checks[check]?.evidence.trim()
    );
    return {
      id,
      status:
        verified.length === requiredChecks.length
          ? 'verified'
          : verified.length > 0
            ? 'partial'
            : 'unverified',
      verifiedChecks: verified.length,
      totalChecks: requiredChecks.length,
      missingChecks: requiredChecks.filter((check) => !verified.includes(check)),
    };
  });
  const verifiedFeatures = features.filter(({ status }) => status === 'verified').length;
  return {
    release,
    sourceCommit: OMP_BASELINE_SOURCE,
    features,
    checks,
    verifiedFeatures,
    totalFeatures: features.length,
    coveragePercent: (100 * verifiedFeatures) / features.length,
    requiredCoveragePercent: 100,
    passes: verifiedFeatures === features.length,
  };
}

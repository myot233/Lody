import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@/utils/logger';

const mocks = vi.hoisted(() => ({
  startLocalAcpAgent: vi.fn(),
  shutdownLocalAcpAgent: vi.fn(async () => {}),
  probeBuiltinAuthentication: vi.fn(),
}));

vi.mock('./acp-runner', () => ({
  startLocalAcpAgent: mocks.startLocalAcpAgent,
  shutdownLocalAcpAgent: mocks.shutdownLocalAcpAgent,
}));

vi.mock('./acp-authentication', () => ({
  probeBuiltinAuthentication: mocks.probeBuiltinAuthentication,
}));

import { fetchAcpCapabilities } from './acp-capabilities';
import { AcpAuthenticationRequiredError } from './agent-client';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

function createSuccessfulStartupResult(sessionResponse?: Record<string, unknown>) {
  return {
    agentProcess: {} as never,
    client: {
      supportsSessionTitleGeneration: () => false,
      supportsAcknowledgedSteer: () => false,
      getGoalCapability: () => undefined,
    } as never,
    acpSessionId: 'acp-session-1' as never,
    sessionResponse: sessionResponse ?? {
      sessionId: 'acp-session-1',
      modes: {
        availableModes: [{ id: 'default', name: 'Default' }],
      },
      models: {
        availableModels: [{ modelId: 'claude-sonnet', name: 'Claude Sonnet' }],
        currentModelId: 'claude-sonnet',
      },
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          type: 'select' as const,
          currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }],
        },
      ],
      availableCommands: [{ name: '/help', description: 'Help' }],
    },
  };
}

function mockStartupWithSessionResponse(sessionResponse: Record<string, unknown>) {
  mocks.startLocalAcpAgent.mockImplementation(async () =>
    createSuccessfulStartupResult({ availableCommands: [], ...sessionResponse })
  );
}

describe('fetchAcpCapabilities', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.probeBuiltinAuthentication.mockResolvedValue({ status: 'unknown' });
    mocks.startLocalAcpAgent.mockImplementation(async () => createSuccessfulStartupResult());
  });

  it('defers builtin Codex authentication to ACP session creation', async () => {
    const result = await fetchAcpCapabilities('builtin', 'codex', createSilentLogger());

    expect(mocks.startLocalAcpAgent).toHaveBeenCalledTimes(1);
    expect(mocks.probeBuiltinAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'builtin',
        agentType: 'codex',
      })
    );
    expect(mocks.startLocalAcpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'builtin',
        agentType: 'codex',
        runtimeOverrides: undefined,
      })
    );
    expect(result.models.map((model) => model.modelId)).toEqual(['claude-sonnet']);
  });

  it('reports missing builtin credentials before starting the ACP adapter', async () => {
    const authMethods = [
      {
        id: 'claude-ai-login',
        name: 'Claude subscription',
        type: 'terminal' as const,
        args: ['auth', 'login', '--claudeai'],
      },
    ];
    mocks.probeBuiltinAuthentication.mockResolvedValue({
      status: 'unauthenticated',
      authMethods,
    });

    const result = fetchAcpCapabilities('builtin', 'claude', createSilentLogger());

    await expect(result).rejects.toBeInstanceOf(AcpAuthenticationRequiredError);
    await expect(result).rejects.toMatchObject({ authMethods });
    expect(mocks.startLocalAcpAgent).not.toHaveBeenCalled();
  });

  it('uses the current working directory for capability probing', async () => {
    const result = await fetchAcpCapabilities('registry', 'probe-agent', createSilentLogger());

    expect(mocks.startLocalAcpAgent).toHaveBeenCalledTimes(1);
    expect(mocks.startLocalAcpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'registry',
        agentType: 'probe-agent',
        workdir: process.cwd(),
      })
    );
    expect(result.availableCommands).toEqual([{ name: '/help', description: 'Help' }]);
  });

  it('records provider title ownership from the live initialization', async () => {
    const startup = createSuccessfulStartupResult();
    Object.assign(startup.client, { supportsSessionTitleGeneration: () => true });
    mocks.startLocalAcpAgent.mockResolvedValue(startup);
    const result = await fetchAcpCapabilities('custom', 'title-agent', createSilentLogger());
    expect(result.sessionTitle).toBe(true);
  });

  it('records the goal actions the live client advertised', async () => {
    const startupResult = createSuccessfulStartupResult();
    startupResult.client = {
      supportsSessionTitleGeneration: () => false,
      supportsAcknowledgedSteer: () => false,
      getGoalCapability: () => ({ version: 1, actions: ['pause', 'resume'] }),
    } as never;
    mocks.startLocalAcpAgent.mockResolvedValue(startupResult);

    const result = await fetchAcpCapabilities('registry', 'goal-agent', createSilentLogger());

    expect(result.goalActions).toEqual(['pause', 'resume']);
  });

  it('leaves goal actions absent for a runtime with no goal extension', async () => {
    mocks.startLocalAcpAgent.mockResolvedValue(createSuccessfulStartupResult());

    const result = await fetchAcpCapabilities('registry', 'plain-agent', createSilentLogger());

    expect(result.goalActions).toBeUndefined();
  });

  it('preserves acknowledged steering support discovered from the live client', async () => {
    const startupResult = createSuccessfulStartupResult();
    startupResult.client = {
      supportsSessionTitleGeneration: () => false,
      supportsAcknowledgedSteer: () => true,
      getGoalCapability: () => undefined,
    } as never;
    mocks.startLocalAcpAgent.mockResolvedValue(startupResult);

    const result = await fetchAcpCapabilities('registry', 'steering-agent', createSilentLogger());

    expect(result.acknowledgedSteer).toBe(true);
  });

  it('uses the latest standard command update for the probed session', async () => {
    mocks.startLocalAcpAgent.mockImplementation(async (options) => {
      options.onUpdateMessage({
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'review', description: 'Stale command' }],
        },
      });
      options.onUpdateMessage({
        sessionId: 'acp-session-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'model', description: 'Show or change the model' }],
        },
      } as never);
      options.onUpdateMessage({
        sessionId: 'other-session',
        update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
      });
      return createSuccessfulStartupResult({
        sessionId: 'acp-session-1',
        availableCommands: [{ name: '/initial', description: 'Initial response' }],
      });
    });

    const result = await fetchAcpCapabilities('registry', 'omp', createSilentLogger());

    expect(result.availableCommands).toEqual([
      { name: 'model', description: 'Show or change the model' },
    ]);
  });

  it('waits for delayed OMP commands after session creation and ignores other sessions', async () => {
    vi.useFakeTimers();
    mocks.startLocalAcpAgent.mockImplementation(async (options) => {
      setTimeout(() => {
        options.onUpdateMessage({
          sessionId: 'other-session',
          update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
        });
      }, 25);
      setTimeout(() => {
        options.onUpdateMessage({
          sessionId: 'acp-session-1',
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              { name: 'model', description: 'Show or change the model', input: { hint: 'model' } },
              { name: 'skill:review', description: 'Review changes' },
            ],
          },
        });
      }, 50);
      return createSuccessfulStartupResult({ sessionId: 'acp-session-1' });
    });

    const probe = fetchAcpCapabilities('registry', 'omp', createSilentLogger());
    await vi.advanceTimersByTimeAsync(25);
    expect(mocks.shutdownLocalAcpAgent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    expect((await probe).availableCommands).toEqual([
      { name: 'model', description: 'Show or change the model' },
      { name: 'skill:review', description: 'Review changes' },
    ]);
    expect(mocks.shutdownLocalAcpAgent).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an empty standard update instead of stale response commands', async () => {
    mocks.startLocalAcpAgent.mockImplementation(async (options) => {
      options.onUpdateMessage({
        sessionId: 'acp-session-1',
        update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
      });
      return createSuccessfulStartupResult();
    });

    const result = await fetchAcpCapabilities('registry', 'omp', createSilentLogger());
    expect(result.availableCommands).toEqual([]);
  });

  it('bounds command discovery for agents that never advertise commands', async () => {
    vi.useFakeTimers();
    mocks.startLocalAcpAgent.mockResolvedValue(
      createSuccessfulStartupResult({ sessionId: 'acp-session-1' })
    );
    const probe = fetchAcpCapabilities('registry', 'silent-agent', createSilentLogger());
    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.shutdownLocalAcpAgent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await probe).availableCommands).toBeUndefined();
    expect(mocks.shutdownLocalAcpAgent).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels delayed command discovery and cleans up without returning capabilities', async () => {
    vi.useFakeTimers();
    mocks.startLocalAcpAgent.mockResolvedValue(
      createSuccessfulStartupResult({ sessionId: 'acp-session-1' })
    );
    const controller = new AbortController();
    const reason = new Error('Cancelled capability refresh');
    const probe = fetchAcpCapabilities(
      'registry',
      'omp',
      createSilentLogger(),
      undefined,
      undefined,
      undefined,
      { signal: controller.signal }
    );
    const rejection = expect(probe).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    await rejection;
    expect(mocks.shutdownLocalAcpAgent).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an explicit empty command list from NewSessionResponse', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      availableCommands: [],
    });

    const result = await fetchAcpCapabilities('registry', 'response-agent', createSilentLogger());

    expect(result.availableCommands).toEqual([]);
  });

  it('ignores a malformed NewSessionResponse command extension', async () => {
    vi.useFakeTimers();
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      availableCommands: [{ name: 123, description: 'invalid' }],
    });

    const probe = fetchAcpCapabilities('registry', 'response-agent', createSilentLogger());
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await probe;

    expect(result.availableCommands).toBeUndefined();
  });

  it('probes registry agents even when their agent type matches a builtin name', async () => {
    const result = await fetchAcpCapabilities('registry', 'codex', createSilentLogger());

    expect(mocks.startLocalAcpAgent).toHaveBeenCalledTimes(1);
    expect(mocks.startLocalAcpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'registry',
        agentType: 'codex',
      })
    );
    expect(result.models.map((model) => model.modelId)).toEqual(['claude-sonnet']);
  });

  it('probes builtin agents when runtime overrides are set', async () => {
    await fetchAcpCapabilities('builtin', 'codex', createSilentLogger(), undefined, undefined, {
      codexPath: '/tmp/lody-test-codex',
    });

    expect(mocks.startLocalAcpAgent).toHaveBeenCalledTimes(1);
    expect(mocks.startLocalAcpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'builtin',
        agentType: 'codex',
        runtimeOverrides: { codexPath: '/tmp/lody-test-codex' },
      })
    );
  });

  it('merges provider env into the capability probe process env', async () => {
    await fetchAcpCapabilities('registry', 'env-agent', createSilentLogger(), {
      ACP_PROVIDER_TOKEN: 'secret-token',
    });

    expect(mocks.startLocalAcpAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'registry',
        agentType: 'env-agent',
        env: expect.objectContaining({
          PATH: process.env.PATH,
          ACP_PROVIDER_TOKEN: 'secret-token',
        }),
      })
    );
  });

  it('derives models from a model-category config option when present', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'opus',
          options: [
            { value: 'opus', name: 'Opus' },
            { value: 'sonnet', name: 'Sonnet' },
          ],
        },
      ],
    });

    const result = await fetchAcpCapabilities('registry', 'config-agent', createSilentLogger());

    expect(result.models).toEqual([
      { modelId: 'opus', name: 'Opus', description: undefined },
      { modelId: 'sonnet', name: 'Sonnet', description: undefined },
    ]);
  });

  it('falls back to the legacy models field for agents without config options', async () => {
    // Agent predating config-option model selection: only the legacy
    // NewSessionResponse.models field, no `model`-category config option.
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      modes: { availableModes: [{ id: 'default', name: 'Default' }] },
      models: {
        availableModels: [
          { modelId: 'legacy-a', name: 'Legacy A', description: 'first' },
          { modelId: 'legacy-b', name: 'Legacy B' },
        ],
        currentModelId: 'legacy-a',
      },
    });

    const result = await fetchAcpCapabilities('custom', 'legacy-agent', createSilentLogger());

    expect(result.models).toEqual([
      { modelId: 'legacy-a', name: 'Legacy A', description: 'first' },
      { modelId: 'legacy-b', name: 'Legacy B', description: undefined },
    ]);
  });

  it('prefers config-option models over the legacy models field when both exist', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      models: {
        availableModels: [{ modelId: 'legacy-only', name: 'Legacy Only' }],
      },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'cfg',
          options: [{ value: 'cfg', name: 'Config Model' }],
        },
      ],
    });

    const result = await fetchAcpCapabilities('registry', 'hybrid-agent', createSilentLogger());

    expect(result.models).toEqual([
      { modelId: 'cfg', name: 'Config Model', description: undefined },
    ]);
  });

  it('returns no models when neither config options nor the legacy field provide them', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      modes: { availableModes: [{ id: 'default', name: 'Default' }] },
    });

    const result = await fetchAcpCapabilities('registry', 'modeless-agent', createSilentLogger());

    expect(result.models).toEqual([]);
  });

  // BC-2026-06-24-ACP-CONFIG-OPTION-AGENT-FILTERED: the current version drops
  // the `agent`-id config option returned by acp-extension-claude.
  it('filters out the `agent` config option while keeping the rest', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'default',
          options: [{ value: 'default', name: 'Default' }],
        },
        {
          id: 'agent',
          name: 'Agent',
          type: 'select',
          currentValue: 'main',
          options: [{ value: 'main', name: 'Main' }],
        },
      ],
    });

    const result = await fetchAcpCapabilities('registry', 'filter-agent', createSilentLogger());

    expect(result.configOptions?.map((opt) => opt.id)).toEqual(['mode']);
  });

  it('returns no config options when only the `agent` option is present', async () => {
    mockStartupWithSessionResponse({
      sessionId: 'acp-session-1',
      configOptions: [
        {
          id: 'agent',
          name: 'Agent',
          type: 'select',
          currentValue: 'main',
          options: [{ value: 'main', name: 'Main' }],
        },
      ],
    });

    const result = await fetchAcpCapabilities('registry', 'filter-agent', createSilentLogger());

    expect(result.configOptions).toBeUndefined();
  });
});

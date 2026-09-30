/** Opt-in native acceptance: no external provider requests, transcripts or user state. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, watch } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { getAskUserQuestionAnswerKey, parseAskUserQuestionPermissionMeta } from '@lody/shared';
import type { AcpSessionNotification, ResolvedMcpServer } from '@lody/shared';
import {
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  startLocalAcpAgent,
  shutdownLocalAcpAgent,
  spawnAcpProcess,
  createAcpClient,
} from '../src/agent/acp-runner';
import { withAcpSessionStartSlot } from '../src/agent/acp-session-start-gate';
import {
  evaluateOmpIntegrationBaseline,
  OMP_BASELINE_RELEASE,
  OMP_BASELINE_BINARY_SHA256,
  OMP_BASELINE_MCP_PATCH_SHA256,
  OMP_BASELINE_MCP_BINARY_SHA256,
  OMP_BASELINE_EXTENDED_PATCH_SHA256,
  OMP_BASELINE_EXTENDED_BINARY_SHA256,
  OMP_BASELINE_CORE_SOURCE,
  OMP_BASELINE_CORE_PATCH_SHA256,
  type OmpBaselineCheck,
} from '../src/agent/omp-integration-baseline';
import type { Logger } from '../src/utils/logger';
import { createStdinWritableStream, createStdoutReadableStream } from '../src/utils/stream';
import {
  lspService,
  dapService,
  syntheticPdf,
  githubService,
  desktopWindowService,
  syntheticWave,
} from './omp-service-fixtures';

const { values } = parseArgs({
  options: {
    binary: { type: 'string' },
    report: { type: 'string' },
    build: { type: 'string' },
  },
});
if (!values.binary || !values.report)
  throw new Error('Use --binary <omp 18.4.3> --report <JSON path>');
const binary = path.resolve(values.binary);
const build = values.build ?? 'official';
assert.ok(
  build === 'official' || build === 'mcp-prompts-fixed' || build === 'acp-extended',
  'Use --build official|mcp-prompts-fixed|acp-extended'
);
const usesMcpFix = build === 'mcp-prompts-fixed';
const usesExtendedAcp = build === 'acp-extended';
const patchSha256 = usesExtendedAcp
  ? OMP_BASELINE_EXTENDED_PATCH_SHA256
  : usesMcpFix
    ? OMP_BASELINE_MCP_PATCH_SHA256
    : undefined;
if (patchSha256) {
  const patchFile = usesExtendedAcp ? 'omp-acp-extended.patch' : 'omp-acp-mcp-prompts.patch';
  assert.equal(
    createHash('sha256')
      .update(await readFile(new URL(`../../../scripts/${patchFile}`, import.meta.url)))
      .digest('hex'),
    patchSha256,
    'Expected the pinned OMP source patch'
  );
}
if (usesExtendedAcp) {
  assert.equal(
    createHash('sha256')
      .update(
        await readFile(new URL('../../../scripts/omp-acp-core-components.patch', import.meta.url))
      )
      .digest('hex'),
    OMP_BASELINE_CORE_PATCH_SHA256,
    'Expected the pinned Core GUI contract patch'
  );
}
// This isolated acceptance process must not import credentials from a login shell.
process.env.LODY_DISABLE_SHELL_ENV = '1';
const fixtureEnvironment: NodeJS.ProcessEnv = Object.fromEntries(
  [
    'PATH',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SHELL',
    'TERM',
    'ELECTRON_RUN_AS_NODE',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))
);
const binarySha256 = createHash('sha256')
  .update(await readFile(binary))
  .digest('hex');
assert.equal(
  binarySha256,
  usesExtendedAcp
    ? OMP_BASELINE_EXTENDED_BINARY_SHA256
    : usesMcpFix
      ? OMP_BASELINE_MCP_BINARY_SHA256
      : OMP_BASELINE_BINARY_SHA256,
  'Expected the pinned Darwin ARM64 OMP build'
);
const version = await promisify(execFile)(binary, ['--version'], { env: fixtureEnvironment });
assert.equal(version.stdout.trim(), `omp/${OMP_BASELINE_RELEASE}`);
const checks: Record<string, OmpBaselineCheck> = {};
const check = async (id: string, run: () => Promise<void> | void) => {
  try {
    await run();
    checks[id] = { status: 'verified', evidence: 'native OMP + Lody ACP client assertion' };
  } catch (error) {
    checks[id] = { status: 'failed', evidence: 'native assertion failed' };
    console.log(
      `${id}: failure kind ${error instanceof assert.AssertionError ? error.operator : error instanceof Error ? error.name : 'unknown'}`
    );
    if (error instanceof Error) console.log(`${id}: ${error.message.slice(0, 2000)}`);
    if (error && typeof error === 'object' && 'data' in error)
      console.log(`${id}: detail ${JSON.stringify(error.data).slice(0, 2000)}`);
  }
  console.log(`${id}: ${checks[id]?.status}`);
};
const logger: Logger = {
  info() {},
  warn() {},
  error() {},
  success() {},
  debug() {},
  trace() {},
  setLevel() {},
  setDebug() {},
  child() {
    return logger;
  },
  async close() {},
};
const terminalManager = {
  async createTerminal() {
    throw new Error('Not enabled');
  },
  async terminalOutput() {
    throw new Error('Not enabled');
  },
  async releaseTerminal() {},
  async waitForTerminalExit() {
    return { exitCode: null, signal: null };
  },
  async killTerminal() {},
};
const workdir = await mkdtemp(path.join(os.tmpdir(), 'lody-omp-baseline-'));
const externalState = await mkdtemp(path.join(os.tmpdir(), 'lody-omp-baseline-external-'));
let desktopProcess: ChildProcess | undefined;
let guiProcess: ChildProcess | undefined;
let guiUrl: string | undefined;
const guiProofs: Array<{
  rendered: string;
  palette: string;
  accent: string;
  revision: number;
  theme: { name: string; foreground: string; background: string; accent: string };
  keybindings: Array<{ key: string }>;
}> = [];
const requests: Array<Record<string, unknown>> = [];
const webRequests: string[] = [];
const speechRequests: Array<{ body: unknown; authenticated: boolean }> = [];
let onJobReady: (() => void) | undefined;
let onJobClosed: (() => void) | undefined;
const jobReady = new Promise<void>((resolve) => {
  onJobReady = resolve;
});
const jobClosed = new Promise<void>((resolve) => {
  onJobClosed = resolve;
});
const pageHtml =
  '<!doctype html><html><head><title>BROWSER_TITLE_SENTINEL</title></head><body><h1>WEB_CONTENT_SENTINEL</h1><button id="change" onclick="document.querySelector(\'#result\').textContent=\'BROWSER_INTERACTION_SENTINEL\'">Change</button><p id="result">Original</p></body></html>';
const updates: AcpSessionNotification[] = [];
const commandsBySession = new Map<string, string[]>();
const recordUpdate = (message: AcpSessionNotification) => {
  updates.push(message);
  if (
    message.sessionId === collabHostSessionId &&
    message.update.sessionUpdate === 'agent_message_chunk' &&
    message.update.content.type === 'text' &&
    message.update.content.text.includes('Waiting for a guest prompt.')
  )
    onCollabReady?.();
  if (message.update.sessionUpdate === 'available_commands_update')
    commandsBySession.set(
      message.sessionId,
      message.update.availableCommands.map(({ name }) => name)
    );
};
let nextTool: { id: string; name: string; args: Record<string, unknown> } | undefined;
const followupTools: NonNullable<typeof nextTool>[] = [];
let nextText: string | undefined;
let authenticated = false;
let holdResponse = false;
let onHeldRequest: (() => void) | undefined;
let onSteerQueued: (() => void) | undefined;
let onSteerStream: ((finish: () => void) => void) | undefined;
let advisorEmitted = false;
let securityStep = 0;
let onSecurityPublished: (() => void) | undefined;
const securityPublished = new Promise<void>((resolve) => {
  onSecurityPublished = resolve;
});
const mcpResponse = (method: string, params: unknown, transport: string) => {
  if (method === 'initialize')
    return {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: 'synthetic-baseline', version: '1' },
    };
  if (method === 'tools/list')
    return {
      tools: [
        {
          name: 'echo',
          description: 'Synthetic acceptance echo',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
          },
        },
      ],
    };
  if (method === 'tools/call')
    return {
      content: [{ type: 'text', text: 'MCP_' + transport + '_SENTINEL ' + JSON.stringify(params) }],
    };
  if (method === 'prompts/list')
    return {
      prompts: [
        {
          name: 'baseline-prompt',
          description: 'Synthetic acceptance prompt',
          arguments: [{ name: 'topic', required: true }],
        },
      ],
    };
  if (method === 'prompts/get')
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'MCP_PROMPT_' + transport + '_SENTINEL ' + JSON.stringify(params),
          },
        },
      ],
    };
  if (method === 'resources/list') return { resources: [] };
  if (method === 'resources/templates/list') return { resourceTemplates: [] };
  return {};
};
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  if (request.method === 'GET') {
    webRequests.push(request.url ?? '');
    if (request.url === '/job') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('JOB_OUTPUT_SENTINEL\n');
      response.once('close', () => onJobClosed?.());
      onJobReady?.();
      return;
    }
    if (request.url === '/page') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(pageHtml);
      return;
    }
    if (request.url === '/document.pdf') {
      response.writeHead(200, { 'content-type': 'application/pdf' });
      response.end(syntheticPdf());
      return;
    }
    if (request.url?.startsWith('/search?')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          results: [
            {
              title: 'WEB_SEARCH_SENTINEL',
              url: 'http://127.0.0.1:' + request.socket.localPort + '/page',
              content: 'Synthetic indexed content',
              engine: 'baseline',
            },
          ],
        })
      );
      return;
    }
    if (request.url === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url !== '/mcp') {
      response.writeHead(404);
      response.end();
      return;
    }
  }
  if (request.url === '/speech/audio/speech') {
    speechRequests.push({
      body: JSON.parse(body),
      authenticated: request.headers.authorization === 'Bearer synthetic-speech-key',
    });
    response.writeHead(200, { 'content-type': 'audio/wav' });
    response.end(syntheticWave());
    return;
  }
  if (request.url === '/mcp') {
    if (request.method !== 'POST') {
      response.writeHead(405);
      response.end();
      return;
    }
    const rpc: unknown = JSON.parse(body);
    if (typeof rpc !== 'object' || rpc === null || !('method' in rpc)) {
      response.writeHead(400);
      response.end();
      return;
    }
    if (!('id' in rpc)) {
      response.writeHead(202);
      response.end();
      return;
    }
    const params = 'params' in rpc ? rpc.params : undefined;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: mcpResponse(String(rpc.method), params, 'HTTP'),
      })
    );
    return;
  }
  const providerRequest = z.record(z.string(), z.unknown()).parse(JSON.parse(body));
  requests.push(providerRequest);
  authenticated ||= request.headers.authorization === 'Bearer synthetic-baseline-key';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const frame = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  if (
    onSteerStream &&
    JSON.stringify(providerRequest.messages).includes('STEER_ORIGINAL_SENTINEL')
  ) {
    const accept = onSteerStream;
    onSteerStream = undefined;
    frame({
      id: 'steer-response',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'STEER_BEFORE_SENTINEL' },
          finish_reason: null,
        },
      ],
    });
    response.flushHeaders();
    accept(() => {
      frame({
        id: 'steer-response',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });
      response.end('data: [DONE]\n\n');
    });
    return;
  }
  if (holdResponse) {
    response.flushHeaders();
    onHeldRequest?.();
    return;
  }
  const hasTool = (name: string) =>
    Array.isArray(providerRequest.tools) &&
    providerRequest.tools.some(
      (tool) =>
        typeof tool === 'object' &&
        tool !== null &&
        'function' in tool &&
        typeof tool.function === 'object' &&
        tool.function !== null &&
        'name' in tool.function &&
        tool.function.name === name
    );
  const advising = hasTool('advise');
  const scanning = hasTool('security_publish');
  if (scanning && JSON.stringify(providerRequest.messages).includes('Published security scan'))
    onSecurityPublished?.();
  const child = !advising && hasTool('yield');
  const childResult = JSON.stringify(providerRequest.messages).includes('A_TASK_MARKER')
    ? 'A_TASK_RESULT'
    : 'B_TASK_RESULT';
  const reviewing =
    child && JSON.stringify(providerRequest.messages).includes('CODE_REVIEW_MARKER');
  const childData = reviewing
    ? {
        overall_correctness: 'incorrect',
        explanation: 'REVIEW_VERDICT_SENTINEL',
        confidence: 1,
        findings: [
          {
            title: 'REVIEW_FINDING_SENTINEL',
            body: 'Synthetic finding in fixture.ts',
            priority: 2,
            confidence: 1,
            file_path: 'fixture.ts',
            line_start: 1,
            line_end: 1,
          },
        ],
      }
    : { sentinel: childResult };
  const tool = scanning
    ? securityStep++ === 0
      ? { id: 'baseline-security-read', name: 'read', args: { path: 'fixture.ts' } }
      : securityStep === 2
        ? {
            id: 'baseline-security-publish',
            name: 'security_publish',
            args: {
              findings: [
                {
                  rule_id: 'baseline.synthetic',
                  title: 'SECURITY_FINDING_SENTINEL',
                  summary: 'Synthetic scan finding',
                  severity: 'low',
                  confidence: 'high',
                  category: 'synthetic',
                  locations: [{ path: 'fixture.ts', start_line: 1 }],
                  evidence: [
                    {
                      label: 'Native source read',
                      explanation: 'The restricted scan session read fixture.ts.',
                    },
                  ],
                },
              ],
              coverage: {
                completeness: 'partial',
                surfaces: [{ label: 'fixture.ts', disposition: 'reported' }],
              },
              report: 'SECURITY_REPORT_SENTINEL: synthetic scan of fixture.ts.',
            },
          }
        : undefined
    : advising
      ? advisorEmitted
        ? undefined
        : {
            id: 'baseline-advisor-note',
            name: 'advise',
            args: { note: 'Preserve ADVISOR_NOTE_SENTINEL in the next step.', severity: 'nit' },
          }
      : child
        ? {
            id: 'baseline-yield-' + (reviewing ? 'review' : childResult),
            name: 'yield',
            args: { data: childData },
          }
        : nextTool;
  if (advising && tool) advisorEmitted = true;
  if (!child && !advising && !scanning) nextTool = followupTools.shift();
  const reply = nextText ?? 'Baseline reply';
  nextText = undefined;
  const delta = tool
    ? {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: tool.id,
            type: 'function',
            function: { name: tool.name, arguments: JSON.stringify(tool.args) },
          },
        ],
      }
    : { role: 'assistant', content: reply };
  frame({ id: 'baseline-response', choices: [{ index: 0, delta, finish_reason: null }] });
  frame({
    id: 'baseline-response',
    choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  });
  response.end('data: [DONE]\n\n');
});
// Controlled relay transports opaque native AES-GCM envelopes unchanged.
const relay = new WebSocketServer({ noServer: true });
const rooms = new Map<
  string,
  { host: WebSocket; guests: Map<number, WebSocket>; nextPeer: number }
>();
let relayFrames = 0;
let relaySawPlaintext = false;
let onRelayRoomClosed: (() => void) | undefined;
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '', 'http://localhost');
  const roomId = /^\/r\/([A-Za-z0-9_-]{10,64})$/.exec(url.pathname)?.[1];
  const role = url.searchParams.get('role');
  if (!roomId || (role !== 'host' && role !== 'guest')) {
    socket.destroy();
    return;
  }
  relay.handleUpgrade(request, socket, head, (ws) => {
    let peer = 0;
    if (role === 'host') {
      if (rooms.has(roomId)) {
        ws.close(4009, 'host exists');
        return;
      }
      rooms.set(roomId, { host: ws, guests: new Map(), nextPeer: 1 });
    } else {
      const room = rooms.get(roomId);
      if (!room) {
        ws.close(4004, 'missing room');
        return;
      }
      peer = room.nextPeer++;
      room.guests.set(peer, ws);
      room.host.send(JSON.stringify({ t: 'peer-joined', peer }));
    }
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      if (bytes.length < 4) return;
      relayFrames++;
      if (bytes.includes(Buffer.from('COLLAB_REMOTE_INPUT_SENTINEL'))) relaySawPlaintext = true;
      const room = rooms.get(roomId);
      if (!room) return;
      if (role === 'host') {
        const target = bytes.readUInt32BE(0);
        if (target === 0) {
          for (const guest of room.guests.values()) guest.send(bytes);
        } else room.guests.get(target)?.send(bytes);
      } else {
        bytes.writeUInt32BE(peer, 0);
        room.host.send(bytes);
      }
    });
    ws.on('close', () => {
      const room = rooms.get(roomId);
      if (!room) return;
      if (role === 'host' && room.host === ws) {
        rooms.delete(roomId);
        for (const guest of room.guests.values()) guest.close(4001, 'room closed');
        onRelayRoomClosed?.();
      } else if (room.guests.delete(peer)) room.host.send(JSON.stringify({ t: 'peer-left', peer }));
    });
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Missing loopback address');
let started: Awaited<ReturnType<typeof startLocalAcpAgent>> | undefined;
let text = '';
const contextUsage: Array<{ size: number; used: number }> = [];
let answerMode = '';
let commandNames: string[] = [];
let onCollabReady: (() => void) | undefined;
let collabHostSessionId: string | undefined;
let resolveCommands: (() => void) | undefined;
const commandsReceived = new Promise<void>((resolve) => {
  resolveCommands = resolve;
});
const signal = AbortSignal.timeout(300_000);
const bounded = async <T>(operation: Promise<T>): Promise<T> => {
  signal.throwIfAborted();
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort?.(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};
const restoredProcesses: Array<Parameters<typeof shutdownLocalAcpAgent>[0]> = [];
const answerPermission = async (
  request: RequestPermissionRequest
): Promise<RequestPermissionResponse> => {
  const meta = parseAskUserQuestionPermissionMeta(request._meta);
  if (meta?.component) {
    assert.ok(guiUrl, 'Native GUI acceptance requires the real renderer driver');
    const response = await fetch(guiUrl, { method: 'POST', body: JSON.stringify(request), signal });
    assert.equal(response.status, 200);
    const parsed = z
      .object({
        outcome: z.unknown(),
        proof: z.object({
          rendered: z.string(),
          palette: z.string(),
          accent: z.string(),
          revision: z.number(),
          theme: z.object({
            name: z.string(),
            foreground: z.string(),
            background: z.string(),
            accent: z.string(),
          }),
          keybindings: z.array(z.object({ key: z.string() })),
        }),
      })
      .parse(await response.json());
    guiProofs.push(parsed.proof);
    const outcome = z
      .object({
        outcome: z.literal('selected'),
        optionId: z.string(),
        _meta: z.record(z.string(), z.unknown()),
      })
      .parse(parsed.outcome);
    return { outcome: outcome as RequestPermissionResponse['outcome'] };
  }
  if (answerMode === 'cancel') return { outcome: { outcome: 'cancelled' } };
  if (!meta) {
    const option = request.options.find(
      ({ kind }) => kind === (answerMode === 'deny' ? 'reject_once' : 'allow_once')
    );
    return option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }
  const answers: Record<string, string | string[]> = {};
  meta.questions.forEach((question, index) => {
    const key = getAskUserQuestionAnswerKey(meta.questions, index);
    if (answerMode === 'custom' && key.endsWith('__other')) answers[key] = 'Custom text';
    else if (answerMode === 'custom' || key.endsWith('__other')) return;
    else if (question.options.some(({ label }) => label === 'Approve'))
      answers[key] = answerMode === 'deny' ? 'Deny' : 'Approve';
    else if (answerMode === 'approve-plan') answers[key] = 'Approve and execute';
    else
      answers[key] =
        answerMode === 'confirm'
          ? 'true'
          : answerMode === 'multi'
            ? ['A', 'B']
            : ['input', 'editor'].includes(answerMode)
              ? 'Edited text'
              : 'B';
  });
  return {
    outcome: {
      outcome: 'selected',
      optionId: 'answer',
      _meta: { lody: { elicitation: { version: 1, answers } } },
    },
  };
};
try {
  if (usesExtendedAcp) {
    const componentsDir = fileURLToPath(new URL('../../../packages/components/', import.meta.url));
    const readyFile = path.join(externalState, 'gui-ready.json');
    const readyWatch = watch(externalState, { signal });
    guiProcess = spawn(
      process.execPath,
      [
        path.join(componentsDir, 'node_modules/vitest/vitest.mjs'),
        'run',
        'tests/ask-user-question-card.test.ts',
        '--testNamePattern',
        'drives the real renderer',
      ],
      {
        cwd: componentsDir,
        env: { ...fixtureEnvironment, LODY_OMP_GUI_READY_FILE: readyFile },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
    let guiError = '';
    guiProcess.stderr?.on('data', (chunk) => {
      guiError += String(chunk);
    });
    const exited = new Promise<never>((_resolve, reject) =>
      guiProcess?.once('exit', () => reject(new Error('GUI renderer exited: ' + guiError)))
    );
    const ready = (async () => {
      for await (const event of readyWatch) {
        if (event.filename === 'gui-ready.json')
          return z
            .object({ port: z.number() })
            .parse(JSON.parse(await readFile(readyFile, 'utf8')));
      }
      throw new Error('GUI renderer did not start');
    })();
    try {
      const address = await bounded(Promise.race([ready, exited]));
      guiUrl = `http://127.0.0.1:${address.port}`;
    } finally {
      await readyWatch.return?.();
    }
    void exited.catch(() => {});
  }
  const agentDir = path.join(workdir, 'agent');
  const fixtureBin = path.join(workdir, 'fixture-bin');
  const ghRequests = path.join(workdir, 'gh-requests.jsonl');
  await mkdir(fixtureBin);
  const ghFixture = path.join(fixtureBin, 'gh');
  await writeFile(ghFixture, '#!' + process.execPath + '\n' + githubService);
  await chmod(ghFixture, 0o700);
  const extensionsDir = path.join(workdir, '.omp', 'extensions');
  await mkdir(agentDir, { recursive: true });
  await mkdir(extensionsDir, { recursive: true });
  await mkdir(path.join(workdir, '.cursor', 'rules'), { recursive: true });
  await writeFile(path.join(workdir, 'AGENTS.md'), 'PROJECT_INSTRUCTION_SENTINEL\n');
  await writeFile(
    path.join(workdir, '.cursor', 'rules', 'baseline.mdc'),
    '---\ndescription: Synthetic acceptance rule\nalwaysApply: true\n---\nFOREIGN_RULE_SENTINEL\n'
  );
  await writeFile(
    path.join(workdir, '.cursor', 'rules', 'baseline-stream.mdc'),
    '---\ndescription: Synthetic streaming rule\ncondition: STREAM_TRIGGER_SENTINEL\nscope: text\n---\nRULE_INJECTION_SENTINEL\n'
  );
  await writeFile(path.join(workdir, 'exploration.txt'), 'EXPLORATION_ONLY_SENTINEL\n');
  await mkdir(path.join(workdir, '.omp', 'commands'), { recursive: true });
  await mkdir(path.join(workdir, '.omp', 'agents'), { recursive: true });
  await writeFile(
    path.join(workdir, '.omp', 'agents', 'baseline-task.md'),
    '---\nname: baseline-task\ndescription: Synthetic acceptance worker\nmodel: baseline/test-model\nthinking: high\nblocking: true\ntools: [read]\n---\nSubmit the synthetic task result with yield.\n'
  );
  await mkdir(path.join(workdir, '.omp', 'skills', 'baseline-skill'), { recursive: true });
  await writeFile(
    path.join(workdir, '.omp', 'commands', 'baseline-file.md'),
    '---\ndescription: Synthetic file command\n---\nFILE_COMMAND_SENTINEL $ARGUMENTS\n'
  );
  await writeFile(
    path.join(workdir, '.omp', 'skills', 'baseline-skill', 'SKILL.md'),
    '---\nname: baseline-skill\ndescription: Synthetic acceptance skill\n---\nSKILL_SENTINEL\n'
  );
  await writeFile(path.join(workdir, 'fixture.txt'), 'BASELINE_FILE_SENTINEL\n');
  await writeFile(path.join(workdir, 'fixture.ts'), 'const original = 1;\n');
  await writeFile(path.join(workdir, 'lsp.ts'), 'const original = 1;\n');
  await writeFile(
    path.join(workdir, 'debug.ts'),
    'const baselineValue = 1;\nconsole.log(baselineValue);\n'
  );
  const lspFixture = path.join(workdir, 'lsp-fixture.mjs');
  const lspRequests = path.join(workdir, 'lsp-requests.jsonl');
  const dapFixture = path.join(workdir, 'dap-fixture.mjs');
  const dapRequests = path.join(workdir, 'dap-requests.jsonl');
  await writeFile(lspFixture, lspService);
  await writeFile(dapFixture, dapService);
  await writeFile(
    path.join(workdir, '.omp', 'lsp.json'),
    JSON.stringify({
      servers: {
        baseline: {
          command: process.execPath,
          args: [lspFixture, lspRequests],
          fileTypes: ['.ts'],
          rootMarkers: ['AGENTS.md'],
          languageId: 'typescript',
        },
      },
    })
  );
  await writeFile(
    path.join(workdir, '.omp', 'dap.json'),
    JSON.stringify({
      adapters: {
        baseline: {
          command: process.execPath,
          args: [dapFixture, dapRequests],
          fileTypes: ['.ts'],
          rootMarkers: ['AGENTS.md'],
        },
      },
    })
  );
  const stdioFixture = path.join(workdir, 'mcp-fixture.mjs');
  const xdevOverlay = path.join(workdir, 'xdev-overlay.yml');
  await writeFile(xdevOverlay, 'tools:\n  xdev: true\n');
  const memoryOverlay = path.join(workdir, 'memory-overlay.yml');
  await writeFile(
    memoryOverlay,
    'memory:\n  backend: mnemopi\nmnemopi:\n  noEmbeddings: true\n  llmMode: none\n  autoRecall: false\n  autoRetain: false\n  scoping: global\n  dbPath: ' +
      JSON.stringify(path.join(workdir, 'memory.db')) +
      '\n'
  );
  const reviewOverlay = path.join(workdir, 'review-overlay.yml');
  await writeFile(reviewOverlay, 'async:\n  enabled: false\n');
  const advisorOverlay = path.join(workdir, 'advisor-overlay.yml');
  await writeFile(
    advisorOverlay,
    'advisor:\n  syncBacklog: "1"\nmodelRoles:\n  advisor: baseline/test-model\n'
  );
  const securityOverlay = path.join(workdir, 'security-overlay.yml');
  await writeFile(securityOverlay, 'security:\n  enabled: true\n');
  const desktopOverlay = path.join(workdir, 'desktop-overlay.yml');
  await writeFile(desktopOverlay, 'computer:\n  enabled: true\n');
  const mediaOverlay = path.join(workdir, 'media-overlay.yml');
  await writeFile(
    mediaOverlay,
    'speechgen:\n  enabled: true\nmodelRoles:\n  speech: deepinfra/hexgrad/Kokoro-82M\nretry:\n  fallbackChains:\n    speech: []\n'
  );
  const jobFixture = path.join(workdir, 'job-fixture.mjs');
  await writeFile(
    jobFixture,
    `import http from 'node:http';const request=http.get('http://127.0.0.1:${address.port}/job',response=>{response.on('data',data=>process.stdout.write(data));});request.on('error',()=>process.exit(1));`
  );
  await writeFile(
    path.join(workdir, 'conflict.txt'),
    'prefix\n<<<<<<< HEAD\nOURS_SENTINEL\n=======\nTHEIRS_SENTINEL\n>>>>>>> other\nsuffix\n'
  );
  await writeFile(
    stdioFixture,
    `import {createInterface} from 'node:readline';\nconst respond=${mcpResponse.toString()};\nfor await(const line of createInterface({input:process.stdin})){const request=JSON.parse(line);if(request.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:respond(request.method,request.params,'STDIO')})+'\\n');}\n`
  );
  await writeFile(
    path.join(workdir, '.omp', 'config.yml'),
    'tools:\n  xdev: false\n  approvalMode: always-ask\nlsp:\n  shared: false\ndebug:\n  enabled: true\ngithub:\n  enabled: true\ncheckpoint:\n  enabled: true\nttsr:\n  builtinRules: false\nastGrep:\n  enabled: true\neval:\n  py: true\n  js: true\ncompaction:\n  keepRecentTokens: 32\n  experimentalContextManagement: true\nmemory:\n  backend: local\nautolearn:\n  enabled: true\nmodelRoles:\n  default: baseline/test-model\n  smol: baseline/test-model\n  slow: baseline/test-model\n  web: web/searxng\n'
  );
  await writeFile(
    path.join(agentDir, 'models.yml'),
    `providers:\n  baseline:\n    baseUrl: http://127.0.0.1:${address.port}/v1\n    apiKey: synthetic-baseline-key\n    auth: apiKey\n    api: openai-completions\n    models:\n      - id: test-model\n        name: Baseline Model\n        reasoning: true\n        input: [text, image]\n        contextWindow: 128000\n        maxTokens: 8192\n        cost: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0}\n  deepinfra:\n    baseUrl: http://127.0.0.1:${address.port}/speech\n    apiKey: synthetic-speech-key\n    auth: apiKey\n`
  );
  const profileAgentDir = path.join(workdir, 'home', '.omp', 'profiles', 'baseline', 'agent');
  await mkdir(profileAgentDir, { recursive: true });
  await writeFile(
    path.join(profileAgentDir, 'models.yml'),
    await readFile(path.join(agentDir, 'models.yml'))
  );
  await writeFile(path.join(agentDir, 'keybindings.yml'), 'tui.select.down: [ctrl+j]\n');
  await writeFile(
    path.join(extensionsDir, 'baseline.ts'),
    `import {writeFile} from 'node:fs/promises';
  export default function(pi) {
    const emit = (name, result) => writeFile(${JSON.stringify(path.join(workdir, 'form-'))}+name+'.json',JSON.stringify({result}));
    pi.registerProvider('security-baseline', {
      baseUrl: 'http://127.0.0.1:${address.port}/v1', api: 'openai-completions', authHeader: true,
      models: [{id:'scan-model',name:'Synthetic Security Model',reasoning:false,input:['text'],cost:{input:1,output:1,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:8192}],
      oauth: {name:'Synthetic Security OAuth',login:async()=>({refresh:'synthetic-refresh',access:'synthetic-security-token',expires:Date.now()+3600000,accountId:'synthetic-account'}),getApiKey:(credential)=>credential.access}
    });
    pi.registerCommand('baseline-security-login',{description:'Synthetic OAuth setup',handler:async(_args,ctx)=>{
      await ctx.modelRegistry.authStorage.oauth.login('security-baseline',{onAuth(){},onPrompt:async()=>{throw new Error('Unexpected synthetic auth prompt');}});
    }});
    pi.on('tool_call',(event,ctx)=>{if(event.toolName==='tts'){const model=ctx.modelRegistry.getAll('tts').find(model=>model.provider==='deepinfra'&&model.id==='hexgrad/Kokoro-82M');if(!model||model.baseUrl!=='http://127.0.0.1:${address.port}/speech')return {block:true,reason:'Synthetic speech route is not isolated'};}});
    pi.on('before_agent_start',async(event)=>{if(event.prompt.includes('HOOK_INPUT_SENTINEL')) return {systemPrompt:event.systemPrompt+'\\nHOOK_OUTPUT_SENTINEL'};});
    pi.registerTool({name:'baseline_tool',label:'Baseline Tool',description:'Synthetic native extension tool',loadMode:'essential',approval:'read',parameters:pi.zod.object({value:pi.zod.string()}),async execute(_id,args){return {content:[{type:'text',text:'EXTENSION_TOOL_SENTINEL '+args.value}],details:{value:args.value}};}});
    pi.registerCommand('baseline-arguments',{description:'Synthetic arguments',handler:async(args)=>emit('arguments',args)});
    pi.registerCommand('baseline-widget',{description:'Synthetic native custom component',handler:async(_args,ctx)=>{
      const original=ctx.ui.theme;
      const themes=await ctx.ui.getAllThemes();
      if(!themes.some(theme=>theme.name==='light'))throw new Error('Missing native light theme');
      const changed=await ctx.ui.setTheme('light');if(!changed.success)throw new Error('Native theme change failed');
      try {
        const result=await ctx.ui.custom((tui,theme,keys,done)=>{
          let count=0;
          return {render:()=>[theme.fg('accent','OMP_WIDGET_SENTINEL count='+count)],invalidate(){},handleInput(data){
            if(keys.matches(data,'tui.select.down')){count++;tui.requestRender();}
            if(keys.matches(data,'tui.select.confirm'))done({count,theme:themes.find(item=>item.name==='light').name,keys:keys.getKeys('tui.select.down')});
          }};
        });
        await emit('widget',result);
      } finally {await ctx.ui.setTheme(original);}
    }});
    for (const name of ['select','confirm','input','editor','single','multi','custom','cancel']) {
      pi.registerCommand('baseline-'+name, {description:'Synthetic acceptance '+name, handler:async (_args,ctx) => {
        let result;
        if(name==='select') result=await ctx.ui.select('Select',['A','B']);
        if(name==='confirm'||name==='cancel') result=await ctx.ui.confirm('Confirm','Proceed?');
        if(name==='input') result=await ctx.ui.input('Input','Enter text');
        if(name==='editor') result=await ctx.ui.editor('Editor','Original text');
        if(['single','multi','custom'].includes(name)) result=await ctx.ui.askDialog([{id:'pick',question:'Which option?',options:[{label:'A'},{label:'B'}],multi:name==='multi'}]);
        await emit(name,result);
      }});
    }
  }`
  );
  started = await startLocalAcpAgent({
    cliType: 'custom',
    agentType: 'omp',
    workdir,
    logger,
    terminalManager,
    customAcp: { command: binary, args: ['acp', '--no-title', '--model', 'baseline/test-model'] },
    env: {
      ...fixtureEnvironment,
      PATH: fixtureBin + path.delimiter + fixtureEnvironment.PATH,
      GH_CONFIG_DIR: path.join(workdir, 'gh-config'),
      GH_HOST: 'github.com',
      GH_TOKEN: 'synthetic-github-key',
      BASELINE_GH_REQUESTS: ghRequests,
      SEARXNG_ENDPOINT: `http://127.0.0.1:${address.port}`,
      SEARXNG_BASIC_USERNAME: undefined,
      SEARXNG_BASIC_PASSWORD: undefined,
      SEARXNG_TOKEN: undefined,
      HOME: path.join(workdir, 'home'),
      XDG_CONFIG_HOME: path.join(workdir, 'home', '.config'),
      PI_CODING_AGENT_DIR: agentDir,
    },
    signal,
    terminalEnabled: false,
    onUpdateMessage(message) {
      recordUpdate(message);
      if (message.update.sessionUpdate === 'available_commands_update') {
        commandNames = message.update.availableCommands.map(({ name }) => name);
        resolveCommands?.();
      }
      if (
        message.update.sessionUpdate === 'agent_message_chunk' &&
        message.update.content.type === 'text'
      ) {
        text += message.update.content.text;
        if (message.update.content.text.includes('Steering input queued.')) onSteerQueued?.();
      }
    },
    onRequestPermission: async (_id, request) => answerPermission(request),
  });
  const active = started;
  const restore = async (
    kind: 'load' | 'fork' | 'new',
    mcpServers: ResolvedMcpServer[] = [],
    profile = false,
    overlay?: string
  ) =>
    withAcpSessionStartSlot(
      { label: 'omp-baseline-restore', logger, abortSignal: signal },
      async () => {
        const agentProcess = spawnAcpProcess({
          cliType: 'custom',
          agentType: 'omp',
          command: binary,
          args: [
            'acp',
            '--no-title',
            '--model',
            'baseline/test-model',
            ...(profile ? ['--profile', 'baseline'] : []),
            ...(overlay ? ['--config', overlay] : []),
          ],
          workdir,
          env: {
            ...fixtureEnvironment,
            PATH: fixtureBin + path.delimiter + fixtureEnvironment.PATH,
            GH_CONFIG_DIR: path.join(workdir, 'gh-config'),
            GH_HOST: 'github.com',
            GH_TOKEN: 'synthetic-github-key',
            BASELINE_GH_REQUESTS: ghRequests,
            SEARXNG_ENDPOINT: `http://127.0.0.1:${address.port}`,
            SEARXNG_BASIC_USERNAME: undefined,
            SEARXNG_BASIC_PASSWORD: undefined,
            SEARXNG_TOKEN: undefined,
            HOME: path.join(workdir, 'home'),
            XDG_CONFIG_HOME: path.join(workdir, 'home', '.config'),
            PI_CODING_AGENT_DIR: profile ? undefined : agentDir,
          },
        });
        let rejectStartup: ((reason: unknown) => void) | undefined;
        const startupAbort = new Promise<never>((_resolve, reject) => {
          rejectStartup = reject;
        });
        const onStartupAbort = () => rejectStartup?.(signal.reason);
        signal.addEventListener('abort', onStartupAbort, { once: true });
        try {
          signal.throwIfAborted();
          const stdout = agentProcess.stdout;
          const stdin = agentProcess.stdin;
          if (!stdout || !stdin) throw new Error('Missing fixture stdio');
          agentProcess.stderr?.resume();
          const restored = await createAcpClient({
            stream: ndJsonStream(
              createStdinWritableStream(stdin),
              createStdoutReadableStream(stdout)
            ),
            workdir,
            logger,
            terminalManager,
            terminalEnabled: false,
            agentConfig: { cliType: 'custom', agentType: 'omp' },
            ...(kind === 'fork'
              ? { forkSessionId: active.acpSessionId }
              : kind === 'load'
                ? { resumeSessionId: active.acpSessionId }
                : {}),
            loadExternalMcpServers: async () => () => ({ servers: mcpServers, problems: [] }),
            onUpdateMessage: recordUpdate,
            onRequestPermission: async (_id, request) => answerPermission(request),
            onContextWindowUsageUpdate: (usage) => contextUsage.push(usage),
            startupAbort,
          });
          const owned = { ...restored, agentProcess, logger, sessionLabel: 'omp-baseline-restore' };
          restoredProcesses.push(owned);
          return owned;
        } catch (error) {
          await shutdownLocalAcpAgent({
            agentProcess,
            logger,
            sessionLabel: 'omp-baseline-startup',
          });
          throw error;
        } finally {
          signal.removeEventListener('abort', onStartupAbort);
        }
      }
    );
  let fileSnapshotTag: string | undefined;
  const prompt = async (content: Parameters<typeof active.client.prompt>[1]) =>
    active.client.prompt(active.acpSessionId, content, { signal });
  const runTool = async (
    id: string,
    name: string,
    args: Record<string, unknown>,
    verify: (output: string) => Promise<void> | void,
    expectedStatus = 'completed',
    target: Pick<typeof active, 'client' | 'acpSessionId'> = active
  ) => {
    await check(id, async () => {
      updates.length = 0;
      nextTool = { id: 'baseline-' + id, name, args };
      const result = await target.client.prompt(
        target.acpSessionId,
        [{ type: 'text', text: 'Synthetic tool acceptance: ' + id }],
        { signal }
      );
      assert.equal(result?.stopReason, 'end_turn');
      const final = updates.findLast(
        ({ update }) =>
          update.sessionUpdate === 'tool_call_update' &&
          update.toolCallId === 'baseline-' + id &&
          update.status === expectedStatus
      );
      assert.ok(final);
      await verify(JSON.stringify(final.update));
    });
  };
  await check('initialize', () => {
    assert.ok(active.client);
  });
  await check('new-session', () => {
    assert.ok(active.acpSessionId);
  });
  await bounded(commandsReceived);
  await check('model-catalog', () => {
    assert.ok(
      active.sessionResponse.configOptions?.some(
        (option) =>
          option.category === 'model' &&
          option.type === 'select' &&
          option.currentValue === 'baseline/test-model'
      )
    );
  });
  await check('model-select', async () => {
    const result = await active.client.setSessionConfigOption(
      active.acpSessionId,
      'model',
      'baseline/test-model'
    );
    assert.ok(
      result?.some(
        (option) => option.id === 'model' && option.currentValue === 'baseline/test-model'
      )
    );
  });
  await check('thinking-select', async () => {
    const result = await active.client.setSessionConfigOption(
      active.acpSessionId,
      'thinking',
      'high'
    );
    assert.ok(result?.some((option) => option.id === 'thinking' && option.currentValue === 'high'));
  });
  await check('mode-select', async () => {
    const result = await active.client.setSessionConfigOption(active.acpSessionId, 'mode', 'plan');
    assert.ok(result?.some((option) => option.id === 'mode' && option.currentValue === 'plan'));
    await active.client.setSessionConfigOption(active.acpSessionId, 'mode', 'default');
  });
  await check('prompt', async () => {
    text = '';
    const result = await active.client.prompt(
      active.acpSessionId,
      [{ type: 'text', text: 'Synthetic baseline prompt' }],
      { signal }
    );
    assert.equal(result?.stopReason, 'end_turn');
    assert.match(text, /Baseline reply/);
    assert.ok(requests.length > 0);
  });
  await check('usage-tokens', async () => {
    text = '';
    await prompt([{ type: 'text', text: '/usage' }]);
    assert.match(text, /Input tokens: 10\b/);
    assert.match(text, /Output tokens: 3\b/);
    assert.match(text, /Total tokens: 13\b/);
  });
  await check('usage-cost', async () => {
    text = '';
    await prompt([{ type: 'text', text: '/usage' }]);
    assert.match(text, /Cost: \$0\.000013\b/);
  });
  const nativeCommand = async (args: string) => {
    assert.ok(commandsBySession.get(active.acpSessionId)?.includes('omp'));
    const offset = updates.length;
    const requestCount = requests.length;
    assert.equal((await prompt([{ type: 'text', text: '/omp ' + args }]))?.stopReason, 'end_turn');
    assert.equal(requests.length, requestCount, 'Management must execute locally');
    const output = updates
      .slice(offset)
      .flatMap(({ sessionId, update }) =>
        sessionId === active.acpSessionId &&
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text'
          ? [update.content.text]
          : []
      )
      .join('');
    return z.record(z.string(), z.unknown()).parse(JSON.parse(output));
  };
  if (usesExtendedAcp) {
    const sessionList = z.array(z.object({ sessionId: z.string(), cwd: z.string() }));
    await check('omp-session-list', async () => {
      const result = await nativeCommand('sessions');
      assert.ok(
        sessionList
          .parse(result.sessions)
          .some((session) => session.sessionId === active.acpSessionId)
      );
    });
    await check('omp-project-list', async () => {
      const result = await nativeCommand('projects');
      assert.ok(
        z
          .array(z.object({ cwd: z.string(), sessionCount: z.number() }))
          .parse(result.projects)
          .some((project) => project.cwd === workdir && project.sessionCount > 0)
      );
    });
    await check('omp-chats', async () => {
      const result = await nativeCommand('chats');
      assert.ok(
        sessionList
          .parse(result.sessions)
          .some((session) => session.cwd === workdir && session.sessionId === active.acpSessionId)
      );
    });
    await check('omp-usage', async () => {
      const result = await nativeCommand('usage');
      assert.deepEqual(z.array(z.unknown()).parse(result.reports), []);
    });
    const extensionList = z.array(
      z.object({ name: z.string(), state: z.string(), source: z.object({ provider: z.string() }) })
    );
    await check('omp-extension-list', async () => {
      const result = await nativeCommand('extensions');
      assert.ok(
        extensionList
          .parse(result.extensions)
          .some((extension) => extension.name === 'baseline-skill' && extension.state === 'active')
      );
    });
    await check('omp-extension-toggle', async () => {
      const before = extensionList.parse((await nativeCommand('extensions')).extensions);
      const provider = before.find((extension) => extension.name === 'baseline-skill')?.source
        .provider;
      assert.ok(provider);
      try {
        assert.equal((await nativeCommand('extension off ' + provider)).enabled, false);
        assert.ok(
          extensionList
            .parse((await nativeCommand('extensions')).extensions)
            .some(
              (extension) => extension.name === 'baseline-skill' && extension.state === 'disabled'
            )
        );
      } finally {
        assert.equal((await nativeCommand('extension on ' + provider)).enabled, true);
      }
      assert.ok(
        extensionList
          .parse((await nativeCommand('extensions')).extensions)
          .some((extension) => extension.name === 'baseline-skill' && extension.state === 'active')
      );
    });
    await check('speech-models', async () => {
      const result = z
        .object({
          defaults: z.object({ textToSpeechModel: z.string(), voice: z.string() }),
          textToSpeech: z.object({
            models: z.array(
              z.object({ value: z.string(), voices: z.array(z.object({ value: z.string() })) })
            ),
          }),
          speechToText: z.object({ models: z.array(z.object({ value: z.string() })) }),
        })
        .parse(await nativeCommand('speech-models'));
      assert.equal(result.defaults.textToSpeechModel, 'local/kokoro');
      assert.ok(
        result.textToSpeech.models.some(
          (model) =>
            model.value === result.defaults.textToSpeechModel &&
            model.voices.some((voice) => voice.value === result.defaults.voice)
        )
      );
      assert.ok(
        result.speechToText.models.some((model) => model.value === 'local/parakeet-tdt-0.6b-v3')
      );
    });
  }
  await check('provider-auth', () => {
    assert.ok(authenticated);
  });
  await check('instructions', () => {
    assert.ok(JSON.stringify(requests).includes('PROJECT_INSTRUCTION_SENTINEL'));
  });
  await check('foreign-rules', () => {
    assert.ok(JSON.stringify(requests).includes('FOREIGN_RULE_SENTINEL'));
  });
  await check('image-input', async () => {
    const before = requests.length;
    const result = await prompt([
      { type: 'text', text: 'Synthetic image input' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      },
    ]);
    assert.equal(result?.stopReason, 'end_turn');
    assert.ok(JSON.stringify(requests.slice(before)).includes('image_url'));
  });
  await check('embedded-context', async () => {
    const before = requests.length;
    await prompt([
      {
        type: 'resource',
        resource: {
          uri: 'file:///synthetic-context.txt',
          mimeType: 'text/plain',
          text: 'EMBEDDED_CONTEXT_SENTINEL',
        },
      },
    ]);
    assert.ok(JSON.stringify(requests.slice(before)).includes('EMBEDDED_CONTEXT_SENTINEL'));
  });
  await check('extension-hook', async () => {
    const before = requests.length;
    await prompt([{ type: 'text', text: 'HOOK_INPUT_SENTINEL' }]);
    assert.ok(JSON.stringify(requests.slice(before)).includes('HOOK_OUTPUT_SENTINEL'));
  });
  await check('command-discovery', async () => {
    await Promise.race([
      commandsReceived,
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      ),
    ]);
    assert.ok(commandNames.includes('model') && commandNames.includes('baseline-confirm'));
  });
  await check('builtin-command', async () => {
    text = '';
    const result = await active.client.prompt(
      active.acpSessionId,
      [{ type: 'text', text: '/model' }],
      { signal }
    );
    assert.equal(result?.stopReason, 'end_turn');
    assert.match(text, /Baseline Model|test-model/);
  });
  await check('command-arguments', async () => {
    await prompt([{ type: 'text', text: '/baseline-arguments --flag a:b quoted value' }]);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(workdir, 'form-arguments.json'), 'utf8')),
      { result: '--flag a:b quoted value' }
    );
  });
  await check('extension-command', () => {
    assert.equal(checks['command-arguments']?.status, 'verified');
  });
  await check('file-command', async () => {
    const before = requests.length;
    await prompt([{ type: 'text', text: '/baseline-file synthetic-argument' }]);
    const forwarded = JSON.stringify(requests.slice(before));
    assert.ok(
      forwarded.includes('FILE_COMMAND_SENTINEL') && forwarded.includes('synthetic-argument')
    );
  });
  await check('skill-discovery', () => {
    assert.ok(commandNames.includes('skill:baseline-skill'));
  });
  await check('skill-invoke', async () => {
    const before = requests.length;
    await prompt([{ type: 'text', text: '/skill:baseline-skill skill-argument' }]);
    const forwarded = JSON.stringify(requests.slice(before));
    assert.ok(forwarded.includes('SKILL_SENTINEL') && forwarded.includes('skill-argument'));
  });
  for (const name of [
    'select',
    'confirm',
    'input',
    'editor',
    'single',
    'multi',
    'custom',
    'cancel',
  ]) {
    await check('form-' + name, async () => {
      answerMode = name;
      text = '';
      const result = await active.client.prompt(
        active.acpSessionId,
        [{ type: 'text', text: '/baseline-' + name }],
        { signal }
      );
      assert.equal(result?.stopReason, 'end_turn');
      const received: unknown = JSON.parse(
        await readFile(path.join(workdir, 'form-' + name + '.json'), 'utf8')
      );
      if (name === 'confirm' || name === 'cancel')
        assert.deepEqual(received, { result: name === 'confirm' });
      else if (['input', 'editor'].includes(name))
        assert.deepEqual(received, { result: 'Edited text' });
      else if (name === 'select') assert.deepEqual(received, { result: 'B' });
      else {
        assert.ok(typeof received === 'object' && received !== null && 'result' in received);
        const serialized = JSON.stringify(received);
        assert.ok(serialized.includes(name === 'custom' ? 'Custom text' : 'B'));
        if (name === 'multi') assert.ok(serialized.includes('A'));
      }
    });
  }
  answerMode = '';
  if (usesExtendedAcp) {
    await check('custom-widgets', async () => {
      text = '';
      const result = await prompt([{ type: 'text', text: '/baseline-widget' }]);
      assert.equal(result?.stopReason, 'end_turn');
      assert.ok(guiProofs.length, 'Native widget output: ' + text);
      assert.equal(
        JSON.parse(await readFile(path.join(workdir, 'form-widget.json'), 'utf8')).result.count,
        1
      );
      assert.deepEqual(
        guiProofs.map((frame) => frame.revision),
        [0, 1]
      );
      assert.ok(guiProofs[0]?.rendered.includes('count=0'));
      assert.ok(guiProofs[1]?.rendered.includes('count=1'));
    });
    await check('themes', () => {
      assert.equal(checks['custom-widgets']?.status, 'verified');
      for (const frame of guiProofs) {
        assert.equal(frame.theme.name, 'light');
        assert.ok(
          frame.palette.includes(frame.theme.foreground) &&
            frame.palette.includes(frame.theme.background)
        );
        assert.ok(frame.accent.includes(frame.theme.accent));
      }
    });
    await check('keybindings', async () => {
      assert.equal(checks['custom-widgets']?.status, 'verified');
      assert.ok(guiProofs[0]?.keybindings.some((binding) => binding.key === 'ctrl+j'));
      assert.deepEqual(
        JSON.parse(await readFile(path.join(workdir, 'form-widget.json'), 'utf8')).result.keys,
        ['ctrl+j']
      );
    });
    const host = await restore('new');
    const guest = await restore('new');
    collabHostSessionId = host.acpSessionId;
    const command = async (target: typeof host, input: string) => {
      const offset = updates.length;
      assert.equal(
        (
          await target.client.prompt(target.acpSessionId, [{ type: 'text', text: input }], {
            signal,
          })
        )?.stopReason,
        'end_turn'
      );
      const output = updates
        .slice(offset)
        .flatMap(({ sessionId, update }) =>
          sessionId === target.acpSessionId &&
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text'
            ? [update.content.text]
            : []
        )
        .join('');
      return z.record(z.string(), z.unknown()).parse(JSON.parse(output));
    };
    let controlLink: string | undefined;
    let viewLink: string | undefined;
    await check('collab-start', async () => {
      assert.notEqual(host.agentProcess.pid, guest.agentProcess.pid);
      await host.client.prompt(
        host.acpSessionId,
        [{ type: 'text', text: 'COLLAB_SNAPSHOT_SENTINEL' }],
        { signal }
      );
      const result = await command(host, `/collab start ws://127.0.0.1:${address.port}`);
      assert.equal(result.role, 'host');
      assert.equal(result.sessionId, host.acpSessionId);
      assert.equal(result.connected, true);
      controlLink = z.string().parse(result.link);
      assert.equal(rooms.size, 1);
    });
    await check('collab-share', async () => {
      assert.ok(controlLink);
      viewLink = z.string().parse((await command(host, '/collab view')).link);
      assert.notEqual(controlLink, viewLink);
      assert.equal(Buffer.from(viewLink.split('.').at(-1)!, 'base64url').length, 32);
      assert.ok(Buffer.from(controlLink.split('.').at(-1)!, 'base64url').length > 32);
    });
    await check('collab-join', async () => {
      assert.ok(controlLink && viewLink);
      const readonly = await command(guest, '/join ' + viewLink);
      assert.equal(readonly.role, 'guest');
      assert.equal(readonly.sessionId, host.acpSessionId);
      assert.equal(readonly.readOnly, true);
      assert.ok(JSON.stringify(readonly.entries).includes('COLLAB_SNAPSHOT_SENTINEL'));
      assert.notEqual(
        guest.acpSessionId,
        host.acpSessionId,
        'Local ACP identity must remain independent'
      );
      const beforeReadonly = requests.length;
      await assert.rejects(() =>
        guest.client.prompt(
          guest.acpSessionId,
          [{ type: 'text', text: 'READONLY_REJECT_SENTINEL' }],
          { signal }
        )
      );
      assert.equal(requests.length, beforeReadonly);
      await command(guest, '/leave');
      const writable = await command(guest, '/join ' + controlLink);
      assert.equal(writable.readOnly, false);
      const ready = new Promise<void>((resolve) => {
        onCollabReady = resolve;
      });
      const hostTurn = host.client.prompt(
        host.acpSessionId,
        [{ type: 'text', text: '/collab watch' }],
        { signal }
      );
      await bounded(ready);
      const offset = updates.length;
      const before = requests.length;
      const guestTurn = await guest.client.prompt(
        guest.acpSessionId,
        [{ type: 'text', text: 'COLLAB_REMOTE_INPUT_SENTINEL' }],
        { signal }
      );
      assert.equal(guestTurn?.stopReason, 'end_turn');
      assert.equal((await bounded(hostTurn))?.stopReason, 'end_turn');
      assert.ok(JSON.stringify(requests.slice(before)).includes('COLLAB_REMOTE_INPUT_SENTINEL'));
      for (const id of [host.acpSessionId, guest.acpSessionId])
        assert.ok(
          updates
            .slice(offset)
            .some(
              (message) =>
                message.sessionId === id &&
                message.update.sessionUpdate === 'agent_message_chunk' &&
                message.update.content.type === 'text' &&
                message.update.content.text.includes('Baseline reply')
            )
        );
      assert.ok(relayFrames > 0);
      assert.equal(relaySawPlaintext, false);
      const roomClosed = new Promise<void>((resolve) => {
        onRelayRoomClosed = resolve;
      });
      await command(guest, '/leave');
      await command(host, '/collab stop');
      await bounded(roomClosed);
      assert.equal(rooms.size, 0);
      onRelayRoomClosed = undefined;
    });
    onCollabReady = undefined;
  }
  await runTool('read-skill-url', 'read', { path: 'skill://baseline-skill' }, (output) => {
    assert.ok(output.includes('SKILL_SENTINEL'));
  });
  await runTool('read-session-url', 'read', { path: 'history://current/full' }, (output) => {
    assert.ok(output.includes('Synthetic baseline prompt'));
  });
  await runTool('read-file', 'read', { path: 'fixture.txt' }, (output) => {
    assert.ok(output.includes('BASELINE_FILE_SENTINEL'));
    fileSnapshotTag = output.match(/\[[^\]]*fixture\.txt#([a-f0-9]{4})\]/i)?.[1];
  });
  await runTool(
    'write-file',
    'write',
    { path: 'written.txt', content: 'WRITTEN_SENTINEL\n' },
    async () => {
      assert.equal(await readFile(path.join(workdir, 'written.txt'), 'utf8'), 'WRITTEN_SENTINEL\n');
    }
  );
  await runTool('grep', 'grep', { path: '.', pattern: 'BASELINE_FILE_SENTINEL' }, (output) => {
    assert.ok(output.includes('fixture.txt'));
  });
  await runTool('glob', 'glob', { path: '*.txt' }, (output) => {
    assert.ok(output.includes('fixture.txt'));
  });
  await runTool('bash', 'bash', { command: 'printf "SHELL_SENTINEL"' }, (output) => {
    assert.ok(output.includes('SHELL_SENTINEL'));
  });
  await check('terminal-output', () => {
    assert.equal(checks.bash?.status, 'verified');
  });
  await runTool(
    'ast-grep',
    'ast_grep',
    { pat: 'const $NAME = $VALUE', path: 'fixture.ts' },
    (output) => {
      assert.ok(output.includes('original'));
    }
  );
  await check('project-config', () => {
    assert.equal(checks['ast-grep']?.status, 'verified');
  });
  await runTool('todo-plan', 'todo', { op: 'init', items: ['Synthetic baseline task'] }, () => {
    assert.ok(
      updates.some(
        ({ update }) =>
          update.sessionUpdate === 'plan' &&
          update.entries.some(({ content }) => content === 'Synthetic baseline task')
      )
    );
  });
  await runTool(
    'edit-file',
    'edit',
    {
      input:
        '*** Begin Patch\n[fixture.txt#' +
        fileSnapshotTag +
        ']\nPUT 1.=1:\n+EDITED_SENTINEL\n*** End Patch',
    },
    async () => {
      assert.equal(await readFile(path.join(workdir, 'fixture.txt'), 'utf8'), 'EDITED_SENTINEL\n');
    }
  );
  await runTool(
    'stale-edit-rejected',
    'edit',
    {
      input:
        '*** Begin Patch\n[fixture.txt#' +
        fileSnapshotTag +
        ']\nPUT 1.=1:\n+MUST_NOT_APPLY\n*** End Patch',
    },
    async () => {
      assert.equal(await readFile(path.join(workdir, 'fixture.txt'), 'utf8'), 'EDITED_SENTINEL\n');
    },
    'failed'
  );
  await runTool(
    'ast-edit-preview',
    'ast_edit',
    { ops: [{ pat: 'const original = 1', out: 'const replaced = 2' }], paths: ['fixture.ts'] },
    async (output) => {
      assert.ok(output.includes('NOT modified'));
      assert.equal(
        await readFile(path.join(workdir, 'fixture.ts'), 'utf8'),
        'const original = 1;\n'
      );
    }
  );
  await runTool(
    'ast-edit-accept',
    'write',
    { path: 'xd://resolve', content: 'Apply the synthetic AST rewrite' },
    async () => {
      assert.match(
        await readFile(path.join(workdir, 'fixture.ts'), 'utf8'),
        /^const replaced\s*=\s*2;?\s*$/
      );
    }
  );
  await runTool('extension-tool', 'baseline_tool', { value: 'native argument' }, (output) => {
    assert.ok(output.includes('EXTENSION_TOOL_SENTINEL native argument'));
  });
  await runTool(
    'eval-javascript',
    'eval',
    {
      language: 'js',
      code: 'globalThis.baselineValue = 7; console.log("EVAL_JS_SENTINEL", globalThis.baselineValue)',
    },
    (output) => {
      assert.ok(output.includes('EVAL_JS_SENTINEL') && output.includes('7'));
    }
  );
  await runTool(
    'eval-python',
    'eval',
    { language: 'py', code: 'baseline_value = 7\nprint("EVAL_PY_SENTINEL", baseline_value)' },
    (output) => {
      assert.ok(output.includes('EVAL_PY_SENTINEL') && output.includes('7'));
    }
  );
  await runTool(
    'eval-tool-reentry',
    'eval',
    { language: 'js', code: 'console.log((await read("fixture.txt")))' },
    (output) => {
      assert.ok(output.includes('EDITED_SENTINEL'));
    }
  );
  await runTool(
    'learn',
    'learn',
    {
      memory: 'SYNTHETIC_LESSON',
      skill: {
        action: 'create',
        name: 'baseline-managed',
        description: 'Synthetic managed skill acceptance',
        body: 'MANAGED_SKILL_SENTINEL',
      },
    },
    (output) => {
      assert.ok(output.includes('baseline-managed'));
    }
  );
  await check('managed-skill', async () => {
    assert.equal(checks.learn?.status, 'verified');
    assert.ok(
      (
        await readFile(
          path.join(agentDir, 'managed-skills', 'baseline-managed', 'SKILL.md'),
          'utf8'
        )
      ).includes('MANAGED_SKILL_SENTINEL')
    );
  });
  await check('permission-allow', () => {
    assert.equal(checks['write-file']?.status, 'verified');
  });
  answerMode = 'deny';
  await runTool(
    'permission-deny',
    'write',
    { path: 'denied.txt', content: 'MUST_NOT_WRITE' },
    async () => {
      await assert.rejects(readFile(path.join(workdir, 'denied.txt'), 'utf8'));
    },
    'failed'
  );
  answerMode = '';
  await active.client.setSessionConfigOption(active.acpSessionId, 'mode', 'plan');
  await runTool(
    'plan-proposal',
    'write',
    { path: 'local://baseline-plan.md', content: '# Baseline plan\n\nRun synthetic acceptance.' },
    (output) => {
      assert.ok(output.includes('baseline-plan.md'));
    }
  );
  answerMode = 'approve-plan';
  await runTool('plan-approve', 'write', { path: 'xd://propose', content: 'baseline' }, () => {
    assert.ok(
      active.client
        .getConfigOptions()
        .some((option) => option.id === 'mode' && option.currentValue === 'default')
    );
  });
  await active.client.setSessionConfigOption(active.acpSessionId, 'mode', 'default');
  answerMode = '';
  await check('extension-reload', async () => {
    await prompt([{ type: 'text', text: '/reload' }]);
    await prompt([{ type: 'text', text: '/baseline-arguments after-reload' }]);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(workdir, 'form-arguments.json'), 'utf8')),
      { result: 'after-reload' }
    );
  });
  await check('cancel', async () => {
    holdResponse = true;
    const held = new Promise<void>((resolve) => {
      onHeldRequest = resolve;
    });
    const completion = prompt([{ type: 'text', text: 'Synthetic cancellable prompt' }]);
    await held;
    await active.client.cancel(active.acpSessionId);
    assert.equal((await completion)?.stopReason, 'cancelled');
    holdResponse = false;
    onHeldRequest = undefined;
    assert.equal(
      (await prompt([{ type: 'text', text: 'Synthetic prompt after cancel' }]))?.stopReason,
      'end_turn'
    );
  });
  let restored: Awaited<ReturnType<typeof restore>> | undefined;
  if (usesExtendedAcp)
    await check('steer', async () => {
      const stream = new Promise<() => void>((resolve) => {
        onSteerStream = resolve;
      });
      const queued = new Promise<void>((resolve) => {
        onSteerQueued = resolve;
      });
      const before = requests.length;
      text = '';
      const original = prompt([{ type: 'text', text: 'STEER_ORIGINAL_SENTINEL' }]);
      const finish = await bounded(stream);
      try {
        const steering = active.client.steerPrompt(
          active.acpSessionId,
          [{ type: 'text', text: 'STEER_INPUT_SENTINEL' }],
          { signal }
        );
        await bounded(queued);
        assert.equal(requests.length, before + 1);
        finish();
        const outcome = await bounded(steering.outcome);
        assert.equal(outcome.outcome, 'applied');
        if (outcome.outcome === 'applied') outcome.application.release();
        assert.equal((await original)?.stopReason, 'end_turn');
        assert.equal((await steering.completion)?.stopReason, 'end_turn');
        assert.ok(
          requests
            .slice(before + 1)
            .some((request) => JSON.stringify(request.messages).includes('STEER_INPUT_SENTINEL'))
        );
        assert.match(text, /STEER_BEFORE_SENTINEL/);
      } finally {
        finish();
        onSteerQueued = undefined;
        onSteerStream = undefined;
      }
    });
  await check('session-load', async () => {
    updates.length = 0;
    restored = await restore('load');
    assert.equal(restored.acpSessionId, active.acpSessionId);
  });
  await check('settings-persistence', () => {
    assert.ok(
      restored?.client
        .getConfigOptions()
        .some((option) => option.id === 'thinking' && option.currentValue === 'high')
    );
  });
  await check('session-history', () => {
    assert.ok(updates.some(({ update }) => update.sessionUpdate === 'user_message_chunk'));
    assert.ok(
      updates.some(
        ({ update }) =>
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text' &&
          update.content.text.includes('Baseline reply')
      )
    );
  });
  await check('session-resume', async () => {
    assert.ok(restored);
    const before = requests.length;
    await restored.client.prompt(
      restored.acpSessionId,
      [{ type: 'text', text: 'Synthetic resumed prompt' }],
      { signal }
    );
    assert.ok(JSON.stringify(requests.slice(before)).includes('Synthetic baseline prompt'));
  });
  await check('session-fork', async () => {
    const forked = await restore('fork');
    assert.notEqual(forked.acpSessionId, active.acpSessionId);
    const before = requests.length;
    assert.equal(
      (
        await forked.client.prompt(
          forked.acpSessionId,
          [{ type: 'text', text: 'Synthetic forked prompt' }],
          { signal }
        )
      )?.stopReason,
      'end_turn'
    );
    assert.ok(JSON.stringify(requests.slice(before)).includes('Synthetic baseline prompt'));
  });
  await check('usage-context', () => {
    assert.ok(contextUsage.some(({ size, used }) => size === 128000 && used > 0));
  });
  await check('stream-rule-injection', async () => {
    const before = requests.length;
    nextText = 'STREAM_TRIGGER_SENTINEL';
    await prompt([{ type: 'text', text: 'Synthetic stream rule acceptance' }]);
    const actual = requests.slice(before);
    assert.ok(actual.length >= 2);
    assert.ok(!JSON.stringify(actual[0]).includes('RULE_INJECTION_SENTINEL'));
    assert.ok(JSON.stringify(actual.slice(1)).includes('RULE_INJECTION_SENTINEL'));
  });
  await runTool('rule-discovery', 'read', { path: 'rule://baseline-stream' }, (output) => {
    assert.ok(output.includes('RULE_INJECTION_SENTINEL'));
  });
  followupTools.push(
    { id: 'baseline-exploration', name: 'read', args: { path: 'exploration.txt' } },
    { id: 'baseline-rewind', name: 'rewind', args: { report: 'REWIND_REPORT_SENTINEL' } }
  );
  await runTool(
    'checkpoint',
    'checkpoint',
    { goal: 'Synthetic context investigation' },
    (output) => {
      assert.ok(
        output.includes('Checkpoint') && output.includes('Synthetic context investigation')
      );
    }
  );
  await check('rewind', async () => {
    assert.ok(
      updates.some(
        ({ update }) =>
          update.sessionUpdate === 'tool_call_update' &&
          update.toolCallId === 'baseline-rewind' &&
          update.status === 'completed'
      )
    );
    const before = requests.length;
    await prompt([{ type: 'text', text: 'Synthetic post-rewind context probe' }]);
    const context = JSON.stringify(requests.slice(before));
    assert.ok(context.includes('REWIND_REPORT_SENTINEL'));
    assert.ok(!context.includes('EXPLORATION_ONLY_SENTINEL'));
  });
  await check('compact', async () => {
    await prompt([
      { type: 'text', text: 'COMPACTION_DISCARD_SENTINEL ' + 'synthetic context '.repeat(4000) },
    ]);
    await prompt([{ type: 'text', text: 'Synthetic recent context' }]);
    text = '';
    nextText = 'COMPACTION_SUMMARY_SENTINEL';
    assert.equal(
      (await prompt([{ type: 'text', text: '/compact soft retain acceptance context' }]))
        ?.stopReason,
      'end_turn'
    );
    assert.match(text, /Compaction complete/);
    const before = requests.length;
    await prompt([{ type: 'text', text: 'Synthetic post-compaction context probe' }]);
    assert.ok(JSON.stringify(requests.slice(before)).includes('COMPACTION_SUMMARY_SENTINEL'));
    assert.ok(!JSON.stringify(requests.slice(before)).includes('COMPACTION_DISCARD_SENTINEL'));
  });
  await runTool(
    'lsp-diagnostics',
    'lsp',
    { action: 'diagnostics', file: 'lsp.ts' },
    async (output) => {
      assert.ok(output.includes('LSP_DIAGNOSTIC_SENTINEL'));
      assert.ok((await readFile(lspRequests, 'utf8')).includes('textDocument/didOpen'));
    }
  );
  await runTool(
    'lsp-navigation',
    'lsp',
    { action: 'definition', file: 'lsp.ts', line: 1, symbol: 'original' },
    async (output) => {
      assert.ok(output.includes('lsp.ts:1:7'));
      assert.ok((await readFile(lspRequests, 'utf8')).includes('textDocument/definition'));
    }
  );
  await runTool(
    'lsp-write',
    'lsp',
    {
      action: 'rename',
      file: 'lsp.ts',
      line: 1,
      symbol: 'original',
      new_name: 'renamed',
      apply: true,
    },
    async () => {
      assert.equal(await readFile(path.join(workdir, 'lsp.ts'), 'utf8'), 'const renamed = 1;\n');
      assert.ok((await readFile(lspRequests, 'utf8')).includes('textDocument/rename'));
    }
  );
  await runTool(
    'dap-session',
    'debug',
    { action: 'launch', adapter: 'baseline', program: 'debug.ts' },
    async (output) => {
      assert.ok(output.includes('baseline-frame'));
      assert.ok((await readFile(dapRequests, 'utf8')).includes('configurationDone'));
    }
  );
  await runTool('dap-step', 'debug', { action: 'step_over' }, async (output) => {
    assert.ok(output.includes('DAP_STEP_SENTINEL'));
    assert.ok((await readFile(dapRequests, 'utf8')).includes('next'));
  });
  await runTool(
    'dap-variables',
    'debug',
    { action: 'variables', variable_ref: 20 },
    async (output) => {
      assert.ok(output.includes('DAP_VARIABLE_SENTINEL'));
      assert.ok((await readFile(dapRequests, 'utf8')).includes('variables'));
    }
  );
  let conflictId: string | undefined;
  await runTool('conflict-read', 'read', { path: 'conflict.txt:conflicts' }, (output) => {
    conflictId = /#(\d+)\s+L/.exec(output)?.[1];
    assert.ok(conflictId);
  });
  await runTool('conflict-read', 'read', { path: 'conflict://' + conflictId }, (output) => {
    assert.ok(output.includes('OURS_SENTINEL') && output.includes('THEIRS_SENTINEL'));
  });
  await runTool(
    'conflict-resolve',
    'write',
    { path: 'conflict://' + conflictId, content: 'RESOLVED_SENTINEL' },
    async () => {
      assert.equal(
        await readFile(path.join(workdir, 'conflict.txt'), 'utf8'),
        'prefix\nRESOLVED_SENTINEL\nsuffix\n'
      );
    }
  );
  let taskOutput = '';
  const tasksBefore = requests.length;
  await runTool(
    'task-fanout',
    'task',
    {
      context: 'Synthetic fanout context',
      tasks: [
        {
          name: 'baseline-a',
          agent: 'baseline-task',
          task: 'A_TASK_MARKER',
          solutionSpace: 'fixed synthetic response',
          outputSchema: {
            type: 'object',
            properties: { sentinel: { type: 'string' } },
            required: ['sentinel'],
          },
        },
        {
          name: 'baseline-b',
          agent: 'baseline-task',
          task: 'B_TASK_MARKER',
          solutionSpace: 'fixed synthetic response',
          outputSchema: {
            type: 'object',
            properties: { sentinel: { type: 'string' } },
            required: ['sentinel'],
          },
        },
      ],
    },
    (output) => {
      taskOutput = output;
      assert.ok(output.includes('A_TASK_RESULT') && output.includes('B_TASK_RESULT'));
      const actual = requests.slice(tasksBefore);
      assert.ok(
        actual.some(
          (request) =>
            JSON.stringify(request.tools ?? []).includes('yield') &&
            JSON.stringify(request.messages).includes('A_TASK_MARKER')
        )
      );
      assert.ok(
        actual.some(
          (request) =>
            JSON.stringify(request.tools ?? []).includes('yield') &&
            JSON.stringify(request.messages).includes('B_TASK_MARKER')
        )
      );
    }
  );
  await check('task-results', () => {
    assert.equal(checks['task-fanout']?.status, 'verified');
    assert.ok(taskOutput.includes('sentinel'));
  });
  await runTool('agent-url', 'read', { path: 'agent://baseline-a' }, (output) => {
    assert.ok(output.includes('A_TASK_RESULT'));
  });
  const reviewAgent = await restore('new', [], false, reviewOverlay);
  let reviewOutput = '';
  await runTool(
    'review-run',
    'task',
    {
      context: 'Synthetic review acceptance',
      tasks: [
        {
          name: 'baseline-review',
          agent: 'reviewer',
          task: 'CODE_REVIEW_MARKER Inspect fixture.ts and submit the synthetic code review.',
          solutionSpace: 'fixed synthetic review response',
        },
      ],
    },
    (output) => {
      reviewOutput = output;
      assert.ok(output.includes('REVIEW_VERDICT_SENTINEL'));
    },
    'completed',
    reviewAgent
  );
  await check('review-verdict', () => {
    assert.equal(checks['review-run']?.status, 'verified');
    assert.ok(reviewOutput.includes('overall_correctness') && reviewOutput.includes('incorrect'));
  });
  await check('review-findings', () => {
    assert.equal(checks['review-run']?.status, 'verified');
    assert.ok(
      reviewOutput.includes('REVIEW_FINDING_SENTINEL') &&
        reviewOutput.includes('fixture.ts') &&
        reviewOutput.includes('line_start')
    );
  });
  const advisorAgent = await restore('new', [], false, advisorOverlay);
  await check('advisor-controls', async () => {
    updates.length = 0;
    await advisorAgent.client.prompt(
      advisorAgent.acpSessionId,
      [{ type: 'text', text: '/advisor on' }],
      { signal }
    );
    assert.ok(JSON.stringify(updates).includes('Advisor enabled'));
    updates.length = 0;
    await advisorAgent.client.prompt(
      advisorAgent.acpSessionId,
      [{ type: 'text', text: '/advisor status' }],
      { signal }
    );
    assert.ok(JSON.stringify(updates).includes('baseline/test-model'));
  });
  await check('advisor-note', async () => {
    nextTool = { id: 'baseline-advisor-read', name: 'read', args: { path: 'fixture.txt' } };
    await advisorAgent.client.prompt(
      advisorAgent.acpSessionId,
      [{ type: 'text', text: 'Synthetic advisor acceptance' }],
      { signal }
    );
    const before = requests.length;
    await advisorAgent.client.prompt(
      advisorAgent.acpSessionId,
      [{ type: 'text', text: 'Synthetic advisor next step' }],
      { signal }
    );
    assert.ok(advisorEmitted);
    const primary = requests
      .slice(before)
      .filter((request) => !JSON.stringify(request.tools ?? []).includes('advise'));
    assert.ok(JSON.stringify(primary).includes('ADVISOR_NOTE_SENTINEL'));
  });
  await advisorAgent.client.prompt(
    advisorAgent.acpSessionId,
    [{ type: 'text', text: '/advisor off' }],
    { signal }
  );
  const memoryAgent = await restore('new', [], false, memoryOverlay);
  let memoryId: string | undefined;
  await runTool(
    'retain',
    'retain',
    { items: [{ content: 'durable baseline preference MEMORY_ORIGINAL_SENTINEL' }] },
    (output) => {
      assert.ok(output.includes('1 memory stored'));
    },
    'completed',
    memoryAgent
  );
  await runTool(
    'recall',
    'recall',
    { query: 'MEMORY_ORIGINAL_SENTINEL' },
    (output) => {
      assert.ok(output.includes('MEMORY_ORIGINAL_SENTINEL'));
      memoryId = /\(id: ([^)]+)\)/.exec(output)?.[1];
      assert.ok(memoryId);
    },
    'completed',
    memoryAgent
  );
  await check('memory-edit', async () => {
    assert.ok(memoryId);
    nextTool = {
      id: 'baseline-memory-full-row',
      name: 'read',
      args: { path: 'memory://' + memoryId },
    };
    await memoryAgent.client.prompt(
      memoryAgent.acpSessionId,
      [{ type: 'text', text: 'Synthetic full memory row inspection' }],
      { signal }
    );
    await runTool(
      'memory-edit',
      'memory_edit',
      { op: 'update', id: memoryId, content: 'durable baseline preference MEMORY_EDITED_SENTINEL' },
      (output) => {
        assert.ok(output.includes('updated'));
      },
      'completed',
      memoryAgent
    );
    assert.equal(checks['memory-edit']?.status, 'verified');
    nextTool = {
      id: 'baseline-memory-edited-row',
      name: 'read',
      args: { path: 'memory://' + memoryId },
    };
    updates.length = 0;
    await memoryAgent.client.prompt(
      memoryAgent.acpSessionId,
      [{ type: 'text', text: 'Synthetic edited memory row verification' }],
      { signal }
    );
    const result = JSON.stringify(updates);
    assert.ok(result.includes('MEMORY_EDITED_SENTINEL'));
    assert.ok(!result.includes('MEMORY_ORIGINAL_SENTINEL'));
  });
  await runTool('web-search', 'web_search', { query: 'synthetic acceptance query' }, (output) => {
    assert.ok(output.includes('WEB_SEARCH_SENTINEL'));
    assert.ok(webRequests.some((url) => url.startsWith('/search?') && url.includes('synthetic')));
  });
  await runTool('read-url', 'read', { path: `http://127.0.0.1:${address.port}/page` }, (output) => {
    assert.ok(output.includes('WEB_CONTENT_SENTINEL'));
    assert.ok(webRequests.includes('/page'));
  });
  await runTool(
    'read-pdf',
    'read',
    { path: `http://127.0.0.1:${address.port}/document.pdf` },
    (output) => {
      assert.ok(output.includes('PDF_CONTENT_SENTINEL'));
      assert.ok(webRequests.includes('/document.pdf'));
    }
  );
  const githubAgent = await restore('new');
  await runTool(
    'read-pr',
    'read',
    { path: 'pr://github.com/baseline/repo/1?comments=0' },
    async (output) => {
      assert.ok(output.includes('GITHUB_PR_SENTINEL'));
      assert.ok((await readFile(ghRequests, 'utf8')).includes('pr'));
    },
    'completed',
    githubAgent
  );
  await runTool(
    'read-issue',
    'read',
    { path: 'issue://github.com/baseline/repo/1?comments=0' },
    async (output) => {
      assert.ok(output.includes('GITHUB_ISSUE_SENTINEL'));
      assert.ok((await readFile(ghRequests, 'utf8')).includes('issue'));
    },
    'completed',
    githubAgent
  );
  await runTool(
    'github-tool',
    'github',
    { op: 'repo_view', repo: 'baseline/repo' },
    async (output) => {
      assert.ok(output.includes('GITHUB_TOOL_SENTINEL'));
      assert.ok((await readFile(ghRequests, 'utf8')).includes('repo'));
    },
    'completed',
    githubAgent
  );
  let browserOutput = '';
  await runTool(
    'browser-open',
    'eval',
    {
      language: 'js',
      code: `try{const tab=await browser.open({name:'baseline',url:'http://127.0.0.1:${address.port}/page',app:{path:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--headless=new','--disable-gpu']}});console.log(await tab.title());console.log(await tab.extract('text'));await tab.click('#change');console.log(await tab.extract('text'));}finally{await browser.close({all:true,kill:true});}`,
    },
    (output) => {
      browserOutput = output;
      assert.ok(output.includes('BROWSER_TITLE_SENTINEL'));
    }
  );
  await check('browser-read', () => {
    assert.equal(checks['browser-open']?.status, 'verified');
    assert.ok(browserOutput.includes('WEB_CONTENT_SENTINEL'));
  });
  await check('browser-interact', () => {
    assert.equal(checks['browser-open']?.status, 'verified');
    assert.ok(browserOutput.includes('BROWSER_INTERACTION_SENTINEL'));
  });
  const deviceAgent = await restore('new', [], false, xdevOverlay);
  await runTool(
    'xdev-tool',
    'write',
    {
      path: 'xd://ast_grep',
      content: JSON.stringify({ pat: 'const $NAME = $VALUE', path: 'fixture.ts' }),
    },
    (output) => {
      assert.ok(output.includes('replaced'));
    },
    'completed',
    deviceAgent
  );
  const mcp = await restore('new', [
    { name: 'baseline_stdio', command: process.execPath, args: [stdioFixture], env: [] },
    {
      type: 'http',
      name: 'baseline_http',
      url: `http://127.0.0.1:${address.port}/mcp`,
      headers: [],
    },
  ]);
  await runTool(
    'mcp-stdio',
    'mcp__baseline_stdio_echo',
    { value: 'stdio roundtrip' },
    (output) => {
      assert.ok(output.includes('MCP_STDIO_SENTINEL') && output.includes('stdio roundtrip'));
    },
    'completed',
    mcp
  );
  await runTool(
    'mcp-http',
    'mcp__baseline_http_echo',
    { value: 'http roundtrip' },
    (output) => {
      assert.ok(output.includes('MCP_HTTP_SENTINEL') && output.includes('http roundtrip'));
    },
    'completed',
    mcp
  );
  await check('mcp-prompts', async () => {
    const commands = commandsBySession.get(mcp.acpSessionId) ?? [];
    for (const transport of ['http', 'stdio']) {
      const command = 'baseline_' + transport + ':baseline-prompt';
      assert.ok(commands.includes(command));
      const before = requests.length;
      const result = await mcp.client.prompt(
        mcp.acpSessionId,
        [
          {
            type: 'text',
            text: '/' + command + ' topic=MCP_ARGUMENT_' + transport.toUpperCase() + '_SENTINEL',
          },
        ],
        { signal }
      );
      assert.equal(result?.stopReason, 'end_turn');
      const payload = JSON.stringify(requests.slice(before));
      assert.ok(payload.includes('MCP_PROMPT_' + transport.toUpperCase() + '_SENTINEL'));
      assert.ok(payload.includes('MCP_ARGUMENT_' + transport.toUpperCase() + '_SENTINEL'));
      assert.equal(payload.includes('/' + command), false);
    }
  });
  await check('named-profile', async () => {
    const profiled = await restore('new', [], true);
    assert.ok(
      profiled.client
        .getConfigOptions()
        .some((option) => option.id === 'model' && option.currentValue === 'baseline/test-model')
    );
    const before = requests.length;
    assert.equal(
      (
        await profiled.client.prompt(
          profiled.acpSessionId,
          [{ type: 'text', text: 'Synthetic profile prompt' }],
          { signal }
        )
      )?.stopReason,
      'end_turn'
    );
    assert.ok(requests.length > before);
  });
  if (usesExtendedAcp) {
    const git = async (...args: string[]) =>
      (
        await promisify(execFile)(
          'git',
          [
            '-c',
            'user.name=OMP Baseline',
            '-c',
            'user.email=baseline@example.invalid',
            '-c',
            'commit.gpgsign=false',
            ...args,
          ],
          { cwd: workdir, env: fixtureEnvironment }
        )
      ).stdout.trim();
    await git('init', '--quiet');
    await git('config', 'user.name', 'OMP Baseline');
    await git('config', 'user.email', 'baseline@example.invalid');
    await git('commit', '--allow-empty', '-m', 'chore: initial synthetic commit');
    await writeFile(path.join(workdir, 'commit-a.txt'), 'COMMIT_A_SENTINEL\n');
    await writeFile(path.join(workdir, 'commit-b.txt'), 'COMMIT_B_SENTINEL\n');
    await git('add', '--', 'commit-a.txt', 'commit-b.txt');
    const commitPlan = {
      commits: [
        {
          changes: [{ path: 'commit-a.txt', kind: 'all' }],
          type: 'feat',
          scope: null,
          summary: 'Added first synthetic feature',
        },
        {
          changes: [{ path: 'commit-b.txt', kind: 'all' }],
          type: 'feat',
          scope: null,
          summary: 'Added second synthetic feature',
          dependencies: [0],
        },
      ],
    };
    await writeFile(path.join(workdir, 'commit-plan.json'), JSON.stringify(commitPlan));
    await writeFile(
      path.join(workdir, 'invalid-commit-plan.json'),
      JSON.stringify({ commits: commitPlan.commits.slice(0, 1) })
    );
    const originalHead = await git('rev-parse', 'HEAD');
    const originalIndex = await git('diff', '--cached', '--binary');
    await check('commit-validation', async () => {
      assert.ok(commandsBySession.get(active.acpSessionId)?.includes('commit-plan'));
      text = '';
      const providerCount = requests.length;
      await prompt([{ type: 'text', text: '/commit-plan apply invalid-commit-plan.json' }]);
      const result = z
        .object({ valid: z.boolean(), errors: z.array(z.string()) })
        .parse(JSON.parse(text));
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((error) => error.includes('commit-b.txt')));
      answerMode = 'cancel';
      text = '';
      await prompt([{ type: 'text', text: '/commit-plan apply commit-plan.json' }]);
      answerMode = '';
      assert.match(text, /aborted by user/);
      assert.equal(requests.length, providerCount);
      assert.equal(await git('rev-parse', 'HEAD'), originalHead);
      assert.equal(await git('diff', '--cached', '--binary'), originalIndex);
    });
    await check('commit-split', async () => {
      answerMode = 'confirm';
      text = '';
      const providerCount = requests.length;
      try {
        await prompt([{ type: 'text', text: '/commit-plan apply commit-plan.json' }]);
      } finally {
        answerMode = '';
      }
      assert.match(text, /Split commits created/);
      assert.equal(requests.length, providerCount);
      assert.equal(await git('rev-parse', 'HEAD~2'), originalHead);
      assert.equal(await git('show', '--format=', '--name-only', 'HEAD~1'), 'commit-a.txt');
      assert.equal(await git('show', '--format=', '--name-only', 'HEAD'), 'commit-b.txt');
      assert.equal(await git('diff', '--cached', '--binary'), '');
    });
  }
  const securityAgent = await restore('new', [], false, securityOverlay);
  let securityScanId: string | undefined;
  await check('security-scan-start', async () => {
    await promisify(execFile)('git', ['init', '--quiet'], { cwd: workdir });
    await securityAgent.client.prompt(
      securityAgent.acpSessionId,
      [{ type: 'text', text: '/baseline-security-login' }],
      { signal }
    );
    await securityAgent.client.setSessionConfigOption(
      securityAgent.acpSessionId,
      'model',
      'security-baseline/scan-model'
    );
    let planId: string | undefined;
    await runTool(
      'security-scan-start',
      'security_scan',
      {
        action: 'preflight',
        target_kind: 'scoped_path',
        include_paths: ['fixture.ts'],
        output_root: path.join(externalState, 'security-results'),
      },
      (output) => {
        planId = /Security plan (secplan_[\w-]+)/.exec(output)?.[1];
        assert.ok(planId);
      },
      'completed',
      securityAgent
    );
    assert.ok(planId);
    await runTool(
      'security-scan-start',
      'security_scan',
      { action: 'start', plan_id: planId },
      (output) => {
        securityScanId = /Security scan (secscan_[\w-]+)/.exec(output)?.[1];
        assert.ok(securityScanId);
        assert.ok(output.includes('started as'));
      },
      'completed',
      securityAgent
    );
    assert.equal(checks['security-scan-start']?.status, 'verified');
  });
  await check('security-scan-results', async () => {
    assert.ok(securityScanId);
    await bounded(securityPublished);
    assert.equal(securityStep, 3);
    const scanRequests = requests.filter((request) =>
      JSON.stringify(request.tools ?? []).includes('security_publish')
    );
    const source = (await readFile(path.join(workdir, 'fixture.ts'), 'utf8')).trim();
    const readReplies = scanRequests
      .flatMap((request) => (Array.isArray(request.messages) ? request.messages : []))
      .filter(
        (message) =>
          typeof message === 'object' &&
          message !== null &&
          'role' in message &&
          message.role === 'tool' &&
          'tool_call_id' in message &&
          message.tool_call_id === 'baseline-security-read'
      );
    assert.ok(JSON.stringify(readReplies).includes(source));
    const securityReader = await restore('new', [], false, securityOverlay);
    await runTool(
      'security-scan-results',
      'read',
      { path: `security://scans/${securityScanId}/report` },
      (output) => {
        assert.ok(output.includes('SECURITY_REPORT_SENTINEL'));
      },
      'completed',
      securityReader
    );
    assert.equal(checks['security-scan-results']?.status, 'verified');
    await runTool(
      'security-scan-results',
      'read',
      { path: `security://scans/${securityScanId}/findings` },
      (output) => {
        assert.ok(output.includes('SECURITY_FINDING_SENTINEL'));
      },
      'completed',
      securityReader
    );
    assert.equal(checks['security-scan-results']?.status, 'verified');
  });
  const mediaAgent = await restore('new', [], false, mediaOverlay);
  await writeFile(
    path.join(workdir, 'fixture.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      'base64'
    )
  );
  await runTool(
    'image-output',
    'read',
    { path: 'fixture.png' },
    (output) => {
      const update = z
        .object({
          content: z.array(z.object({ type: z.string(), content: z.unknown().optional() })),
        })
        .parse(JSON.parse(output));
      const image = update.content
        .map((block) =>
          z
            .object({
              type: z.string(),
              data: z.string().optional(),
              mimeType: z.string().optional(),
            })
            .safeParse(block.content)
        )
        .find((parsed) => parsed.success && parsed.data.type === 'image');
      assert.ok(image?.success && image.data.data);
      assert.equal(image.data.mimeType, 'image/webp');
      const bytes = Buffer.from(image.data.data, 'base64');
      assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
      assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP');
      assert.ok(bytes.length > 20);
    },
    'completed',
    mediaAgent
  );
  await runTool(
    'audio-output',
    'tts',
    {
      text: 'Synthetic speech acceptance',
      voice_id: 'baseline-voice',
      output_path: 'speech.wav',
    },
    async (output) => {
      assert.ok(output.includes('Saved 48 bytes'));
      assert.deepEqual(await readFile(path.join(workdir, 'speech.wav')), syntheticWave());
      assert.deepEqual(speechRequests, [
        {
          authenticated: true,
          body: {
            model: 'hexgrad/Kokoro-82M',
            input: 'Synthetic speech acceptance',
            voice: 'baseline-voice',
            response_format: 'wav',
          },
        },
      ]);
    },
    'completed',
    mediaAgent
  );
  const jobsAgent = await restore('new');
  let jobId: string | undefined;
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  await runTool(
    'job-start',
    'bash',
    { command: `${quote(process.execPath)} ${quote(jobFixture)}`, async: true, timeout: 0 },
    async (output) => {
      jobId = /"jobId":"([^"]+)"/.exec(output)?.[1];
      assert.ok(jobId);
      assert.ok(output.includes('"state":"running"'));
      await bounded(jobReady);
    },
    'completed',
    jobsAgent
  );
  await runTool(
    'job-output',
    'read',
    { path: 'proc://' + jobId },
    (output) => {
      assert.equal(checks['job-start']?.status, 'verified');
      assert.ok(output.includes('JOB_OUTPUT_SENTINEL'));
      assert.ok(output.includes('running'));
    },
    'completed',
    jobsAgent
  );
  await check('job-cancel', async () => {
    assert.equal(checks['job-start']?.status, 'verified');
    await runTool(
      'job-cancel',
      'write',
      { path: `proc://${jobId}/kill` },
      (output) => {
        assert.ok(output.includes('cancelled'));
      },
      'completed',
      jobsAgent
    );
    assert.equal(checks['job-cancel']?.status, 'verified');
    await bounded(jobClosed);
    await runTool(
      'job-cancel',
      'read',
      { path: 'proc://' + jobId },
      (output) => {
        assert.ok(output.includes('cancelled'));
      },
      'completed',
      jobsAgent
    );
    assert.equal(checks['job-cancel']?.status, 'verified');
  });
  const desktopAgent = await restore('new', [], false, desktopOverlay);
  const desktopSource = path.join(workdir, 'desktop-fixture.swift');
  const desktopBinary = path.join(workdir, 'desktop-fixture');
  const desktopResult = path.join(workdir, 'desktop-result.txt');
  let desktopChanged: Promise<void> | undefined;
  await check('computer-windows', async () => {
    assert.equal(process.platform, 'darwin');
    await writeFile(desktopSource, desktopWindowService);
    await promisify(execFile)('/usr/bin/swiftc', [desktopSource, '-o', desktopBinary], { signal });
    desktopProcess = spawn(desktopBinary, [desktopResult], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
      env: { ...fixtureEnvironment, HOME: path.join(workdir, 'home') },
    });
    const child = desktopProcess;
    child.stderr?.resume();
    let ready: (() => void) | undefined;
    let changed: (() => void) | undefined;
    const desktopReady = new Promise<void>((resolve, reject) => {
      ready = resolve;
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Native desktop fixture exited before readiness')));
    });
    desktopChanged = new Promise<void>((resolve) => {
      changed = resolve;
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('ready\n')) ready?.();
      if (output.includes('changed\n')) changed?.();
    });
    await bounded(desktopReady);
    await runTool(
      'computer-windows',
      'eval',
      {
        code: `const windows=await computer.windows({title:'OMP_COMPUTER_WINDOW_SENTINEL'});if(windows.length!==1||windows[0].pid!==${child.pid})throw new Error('Wrong native window');console.log('COMPUTER_WINDOW_SENTINEL');`,
        language: 'js',
      },
      (output) => {
        assert.ok(output.includes('COMPUTER_WINDOW_SENTINEL'));
      },
      'completed',
      desktopAgent
    );
    assert.equal(checks['computer-windows']?.status, 'verified');
  });
  await check('computer-screenshot', async () => {
    assert.equal(checks['computer-windows']?.status, 'verified');
    await runTool(
      'computer-screenshot',
      'eval',
      {
        code: `const caps=await computer.capabilities();if(!caps.capture)throw new Error('Native capture permission unavailable');const win=await computer.window({title:'OMP_COMPUTER_WINDOW_SENTINEL'});const capture=await win.screenshot();if(capture.width<300||capture.height<150)throw new Error('Invalid native capture');const fs=await import('node:fs/promises');const png=await fs.readFile(capture.path);if(png.readUInt32BE(0)!==0x89504e47)throw new Error('Invalid PNG');await fs.unlink(capture.path);console.log('COMPUTER_SCREENSHOT_SENTINEL');`,
        language: 'js',
      },
      (output) => {
        assert.ok(output.includes('COMPUTER_SCREENSHOT_SENTINEL'));
        assert.ok(output.includes('"type":"image"'));
      },
      'completed',
      desktopAgent
    );
    assert.equal(checks['computer-screenshot']?.status, 'verified');
  });
  await check('computer-input', async () => {
    assert.equal(checks['computer-windows']?.status, 'verified');
    await runTool(
      'computer-input',
      'eval',
      {
        code: `const caps=await computer.capabilities();if(!caps.ax)throw new Error('Native accessibility permission unavailable');const win=await computer.window({title:'OMP_COMPUTER_WINDOW_SENTINEL'});const buttons=await win.find({title:'Baseline change'});if(buttons.length!==1)throw new Error('Missing fixture button');await buttons[0].press();console.log('COMPUTER_PRESS_SENTINEL');`,
        language: 'js',
      },
      async (output) => {
        assert.ok(output.includes('COMPUTER_PRESS_SENTINEL'));
        assert.ok(desktopChanged);
        await bounded(desktopChanged);
        assert.equal(await readFile(desktopResult, 'utf8'), 'COMPUTER_INPUT_SENTINEL');
      },
      'completed',
      desktopAgent
    );
    assert.equal(checks['computer-input']?.status, 'verified');
  });
  await check('close', async () => {
    assert.equal(await active.client.closeSession(active.acpSessionId), true);
  });
} finally {
  if (guiUrl) await fetch(guiUrl + '/stop').catch(() => {});
  if (guiProcess && guiProcess.exitCode === null && guiProcess.signalCode === null)
    guiProcess.kill('SIGTERM');
  if (desktopProcess && desktopProcess.exitCode === null && desktopProcess.signalCode === null) {
    const child = desktopProcess;
    const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await closed;
  }
  for (const owned of restoredProcesses) await shutdownLocalAcpAgent(owned);
  if (started) await shutdownLocalAcpAgent({ ...started, logger, sessionLabel: 'omp-baseline' });
  for (const client of relay.clients) client.terminate();
  await new Promise<void>((resolve) => relay.close(() => resolve()));
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await rm(workdir, { recursive: true, force: true });
  await rm(externalState, { recursive: true, force: true });
}
const report = evaluateOmpIntegrationBaseline(OMP_BASELINE_RELEASE, checks);
await writeFile(
  path.resolve(values.report),
  JSON.stringify(
    patchSha256
      ? {
          ...report,
          runtime: {
            distribution: build,
            sha256: binarySha256,
            patchSha256,
            ...(usesExtendedAcp
              ? {
                  core: {
                    sourceCommit: OMP_BASELINE_CORE_SOURCE,
                    patchSha256: OMP_BASELINE_CORE_PATCH_SHA256,
                  },
                }
              : {}),
          },
        }
      : { ...report, runtime: { distribution: 'official-darwin-arm64', sha256: binarySha256 } },
    null,
    2
  ) + '\n'
);
console.log(
  `OMP baseline (${build}): ${report.verifiedFeatures}/${report.totalFeatures} (${report.coveragePercent.toFixed(2)}%); 100%: ${report.passes}`
);
if (!report.passes) process.exitCode = 1;

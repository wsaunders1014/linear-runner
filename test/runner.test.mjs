import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWebhookServer } from '../src/server.mjs';
import { computeLinearSignature } from '../src/verify.mjs';
import { getLauncher } from '../src/launchers/index.mjs';
import { parseCommentDirectives } from '../src/directives.mjs';
import { ROOT_DIR } from '../src/config.mjs';

const SECRET = 'test-linear-webhook-secret-12345';

function makeMockLinearClient(overrides = {}) {
  const commentsCreated = [];
  const reviewMoves = [];
  const stateMoves = [];
  const fetchedIssues = [];

  return {
    commentsCreated,
    reviewMoves,
    stateMoves,
    fetchedIssues,
    async getViewer() {
      return { id: 'user-will', name: 'Will Saunders', displayName: 'will' };
    },
    async getIssueWithComments(issueId) {
      fetchedIssues.push(issueId);
      return (
        overrides.issueWithComments || {
          id: issueId,
          identifier: 'ENG-42',
          title: 'Fix login redirect',
          description: 'Investigate redirect loop after sign-in.',
          url: 'https://linear.app/acme/issue/ENG-42',
          state: { id: 'st-prog', name: 'In Progress' },
          labels: { nodes: [{ name: 'agent' }] },
          team: {
            id: 'team-1',
            key: 'ENG',
            states: {
              nodes: [
                { id: 'st-todo', name: 'Todo', type: 'unstarted' },
                { id: 'st-prog', name: 'In Progress', type: 'started' },
                { id: 'st-rev', name: 'In Review', type: 'started' },
              ],
            },
          },
          comments: {
            nodes: [
              {
                id: 'c-1',
                body: '### Implementation Plan\n1. Update redirect guard.',
                createdAt: '2026-11-18T22:00:00Z',
                user: { id: 'bot', name: 'Bot', displayName: 'bot' },
              },
              {
                id: 'c-2',
                body: 'Use option B for question 1 please.',
                createdAt: '2026-11-18T22:05:00Z',
                user: { id: 'user-will', name: 'Will Saunders', displayName: 'will' },
              },
            ],
          },
        }
      );
    },
    async createComment(issueId, body, opts = {}) {
      const id = `comment-${commentsCreated.length + 1}`;
      commentsCreated.push({ id, issueId, body, parentId: opts.parentId || null });
      return { id };
    },
    async moveIssueToState(params) {
      stateMoves.push(params);
      return { id: params.issue.id };
    },
    async moveIssueToReview(params) {
      reviewMoves.push(params);
      return { id: params.issue.id };
    },
  };
}

async function withTestServer(overrides = {}, deps = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-runner-test-'));
  const repoDir = path.join(tmpDir, 'repo');
  const dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(repoDir, { recursive: true });

  const spawns = [];
  const silentLogger = { log() {}, warn() {}, error() {} };
  const linearClient = deps.linearClient || makeMockLinearClient();

  const config = {
    rootDir: ROOT_DIR,
    webhookSecret: SECRET,
    linearApiKey: 'test-linear-api-key',
    repoPath: repoDir,
    repoMap: {},
    allowedRepoPaths: new Set([repoDir]),
    models: {},
    host: '127.0.0.1',
    port: 0,
    defaultAgent: 'agy',
    requiredLabel: 'agent',
    planLabel: 'plan',
    delegateLabel: 'delegate',
    inProgressStateName: 'In Progress',
    inReviewStateName: 'In Review',
    blockedStateName: 'Blocked',
    reviewMention: '',
    dryRun: false,
    dataDir,
    maxBodyBytes: 1024 * 1024,
    maxTimestampAgeMs: 60_000,
    maxConcurrentJobs: 1,
    jobTimeoutMs: 60_000,
    ...overrides,
  };

  const spawnFn =
    deps.spawnFn ||
    (async (invocation) => {
      spawns.push(invocation);
      const isAgy = invocation.command === 'agy';
      const isClaude = invocation.command === 'claude';
      const bodyText =
        '## Plan\n1. Inspect auth flow.\n\n## Open Questions & Decisions\n- Q1: Keep cookie? **(Recommended) Yes** / No';
      const stdout = isAgy
        ? JSON.stringify({ conversation_id: 'conv-agy-123', response: bodyText })
        : isClaude
          ? JSON.stringify({ session_id: 'sess-claude-456', result: bodyText })
          : bodyText;
      return { code: 0, signal: null, timedOut: false, stdout, stderr: '' };
    });

  const { server, store, runner } = createWebhookServer(config, {
    logger: silentLogger,
    linearClient,
    spawnFn,
    ...deps,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function waitForIdle() {
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      if (runner.activeCount === 0 && runner.queue.length === 0) return;
    }
  }

  async function postWebhook(payload, { signature, deliveryId = crypto.randomUUID(), rawOverride } = {}) {
    const rawBody = rawOverride ?? Buffer.from(JSON.stringify(payload), 'utf8');
    const sig = signature !== undefined ? signature : computeLinearSignature(rawBody, SECRET);
    const headers = { 'Content-Type': 'application/json' };
    if (sig !== null) headers['Linear-Signature'] = sig;
    if (deliveryId !== null) headers['Linear-Delivery'] = deliveryId;

    const res = await fetch(`${baseUrl}/linear`, {
      method: 'POST',
      headers,
      body: rawBody,
    });
    const json = await res.json();
    await waitForIdle();
    return { status: res.status, json };
  }

  async function cleanup() {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return { baseUrl, config, store, runner, spawns, linearClient, repoDir, dataDir, postWebhook, cleanup };
}

function makeIssuePayload(overrides = {}) {
  const id = overrides.data?.id || crypto.randomUUID();
  return {
    action: 'create',
    type: 'Issue',
    webhookTimestamp: Date.now(),
    url: 'https://linear.app/acme/issue/ENG-42',
    ...overrides,
    data: {
      id,
      identifier: 'ENG-42',
      title: 'Fix login redirect',
      description: 'Investigate redirect loop after sign-in.',
      state: { id: 'st-todo', name: 'Todo' },
      labels: [{ name: 'agent' }, { name: 'plan' }],
      ...(overrides.data || {}),
    },
  };
}

function makeCommentPayload(overrides = {}) {
  const id = overrides.data?.id || crypto.randomUUID();
  const issueId = overrides.data?.issueId || crypto.randomUUID();
  return {
    action: 'create',
    type: 'Comment',
    webhookTimestamp: Date.now(),
    url: 'https://linear.app/acme/issue/ENG-42#comment-1',
    ...overrides,
    data: {
      id,
      issueId,
      body: 'Looks good, change step 2.',
      parentId: null,
      user: { id: 'user-will', name: 'Will Saunders', displayName: 'will' },
      issue: { id: issueId, identifier: 'ENG-42', title: 'Fix login redirect' },
      ...(overrides.data || {}),
    },
  };
}

test('rejects missing, invalid, or tampered Linear-Signature with 401', async () => {
  const ctx = await withTestServer();
  try {
    const payload = makeIssuePayload();

    assert.equal((await ctx.postWebhook(payload, { signature: null })).status, 401);
    assert.equal((await ctx.postWebhook(payload, { signature: 'a'.repeat(64) })).status, 401);
    assert.equal(
      (
        await ctx.postWebhook(payload, {
          signature: `sha256=${computeLinearSignature(Buffer.from(JSON.stringify(payload)), SECRET)}`,
        })
      ).status,
      401
    );

    const originalRaw = Buffer.from(JSON.stringify(payload), 'utf8');
    const validSig = computeLinearSignature(originalRaw, SECRET);
    const tamperedRaw = Buffer.from(JSON.stringify({ ...payload, action: 'update' }), 'utf8');
    assert.equal(
      (await ctx.postWebhook(payload, { rawOverride: tamperedRaw, signature: validSig })).status,
      401
    );
    assert.equal(ctx.spawns.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('rejects webhookTimestamp older than 60s or in the future with 400', async () => {
  const fixedNow = 1_750_000_000_000;
  const ctx = await withTestServer({}, { now: () => fixedNow });
  try {
    const tooOld = await ctx.postWebhook(makeIssuePayload({ webhookTimestamp: fixedNow - 60_001 }));
    assert.equal(tooOld.status, 400);
    assert.equal(tooOld.json.reason, 'timestamp_too_old');

    const inFuture = await ctx.postWebhook(makeIssuePayload({ webhookTimestamp: fixedNow + 1 }));
    assert.equal(inFuture.status, 400);
    assert.equal(inFuture.json.reason, 'timestamp_in_future');

    const onBoundary = await ctx.postWebhook(makeIssuePayload({ webhookTimestamp: fixedNow - 60_000 }));
    assert.equal(onBoundary.status, 200);
    assert.equal(onBoundary.json.accepted, true);
  } finally {
    await ctx.cleanup();
  }
});

test('direct-to-implement: ticket with `agent` but no `plan` ignores create and implements on In Progress', async () => {
  const ctx = await withTestServer();
  try {
    const issueId = crypto.randomUUID();

    // Created with `agent` only (no `plan`) -> ignored
    const created = await ctx.postWebhook(
      makeIssuePayload({
        action: 'create',
        data: { id: issueId, labels: [{ name: 'agent' }] },
      })
    );
    assert.equal(created.status, 200);
    assert.equal(created.json.ignored, true);
    assert.equal(created.json.reason, 'missing_plan_label');
    assert.equal(ctx.spawns.length, 0);

    // Moved to In Progress -> implements directly, posts debrief + assumptions, moves to In Review
    const moved = await ctx.postWebhook(
      makeIssuePayload({
        action: 'update',
        updatedFrom: { stateId: 'st-todo' },
        data: {
          id: issueId,
          state: { id: 'st-prog', name: 'In Progress' },
          labels: [{ name: 'agent' }],
        },
      })
    );
    assert.equal(moved.status, 200);
    assert.equal(moved.json.accepted, true);
    assert.equal(moved.json.phase, 'implement');
    assert.equal(ctx.spawns.length, 1);
    assert.ok(ctx.spawns[0].args.includes('accept-edits'));
    assert.equal(ctx.linearClient.commentsCreated.length, 1);
    assert.ok(ctx.linearClient.commentsCreated[0].body.includes('Implementation Debrief'));
    assert.equal(ctx.linearClient.reviewMoves.length, 1);
    assert.equal(ctx.linearClient.reviewMoves[0].stateName, 'In Review');
  } finally {
    await ctx.cleanup();
  }
});

test('plan + thread reply resumes exact conversation in plan mode without building until In Progress', async () => {
  const ctx = await withTestServer();
  try {
    const issueId = crypto.randomUUID();

    // 1. Issue created with `agent` + `plan` -> posts plan comment & saves conversation_id
    const planRes = await ctx.postWebhook(
      makeIssuePayload({
        action: 'create',
        data: { id: issueId, labels: [{ name: 'agent' }, { name: 'plan' }] },
      })
    );
    assert.equal(planRes.status, 200);
    assert.equal(planRes.json.phase, 'plan');
    assert.equal(ctx.linearClient.commentsCreated.length, 1);
    const planCommentId = ctx.linearClient.commentsCreated[0].id;

    // 2. Bot's own comment webhook is ignored (loop protection)
    const botEcho = await ctx.postWebhook(
      makeCommentPayload({
        data: {
          issueId,
          body: ctx.linearClient.commentsCreated[0].body,
          parentId: null,
        },
      })
    );
    assert.equal(botEcho.status, 200);
    assert.equal(botEcho.json.ignored, true);
    assert.equal(botEcho.json.reason, 'bot_comment');

    // 3. Standalone human comment without `/agent` is ignored
    const standaloneNote = await ctx.postWebhook(
      makeCommentPayload({
        data: { issueId, body: 'Note to self: check staging later', parentId: null },
      })
    );
    assert.equal(standaloneNote.status, 200);
    assert.equal(standaloneNote.json.ignored, true);
    assert.equal(standaloneNote.json.reason, 'not_agent_thread_or_prefix');

    // 4. Reply directly to the plan comment thread -> resumes `conv-agy-123` in PLAN mode (does not build yet)
    const replyRes = await ctx.postWebhook(
      makeCommentPayload({
        data: {
          issueId,
          parentId: planCommentId,
          body: 'Use option B for Q1 instead.',
        },
      })
    );
    assert.equal(replyRes.status, 200);
    assert.equal(replyRes.json.accepted, true);
    assert.equal(replyRes.json.phase, 'plan');
    assert.equal(replyRes.json.resuming, true);
    assert.equal(ctx.spawns.length, 2);
    assert.ok(ctx.spawns[1].args.includes('--conversation'));
    assert.ok(ctx.spawns[1].args.includes('conv-agy-123'));
    assert.ok(ctx.spawns[1].args.includes('plan'));
    // Reply is nested in the same thread and does NOT move ticket to In Review
    assert.equal(ctx.linearClient.commentsCreated.length, 2);
    assert.equal(ctx.linearClient.commentsCreated[1].parentId, planCommentId);
    assert.equal(ctx.linearClient.reviewMoves.length, 0);

    // 5. Move to In Progress -> implements, posts debrief, moves to In Review
    const implRes = await ctx.postWebhook(
      makeIssuePayload({
        action: 'update',
        updatedFrom: { stateId: 'st-todo' },
        data: {
          id: issueId,
          state: { id: 'st-prog', name: 'In Progress' },
          labels: [{ name: 'agent' }, { name: 'plan' }],
        },
      })
    );
    assert.equal(implRes.status, 200);
    assert.equal(implRes.json.phase, 'implement');
    assert.equal(ctx.spawns.length, 3);
    assert.ok(ctx.spawns[2].args.includes('accept-edits'));
    assert.equal(ctx.linearClient.reviewMoves.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test('supports standalone `/agent` comments with inline `/model` and rejects unsafe model IDs', async () => {
  const ctx = await withTestServer();
  try {
    const issueId = crypto.randomUUID();
    const res = await ctx.postWebhook(
      makeCommentPayload({
        data: {
          issueId,
          body: '/agent /claude /model sonnet-4 /plan Check the auth middleware',
        },
      })
    );
    assert.equal(res.status, 200);
    assert.equal(res.json.accepted, true);
    assert.equal(res.json.agent, 'claude');
    assert.equal(res.json.model, 'sonnet-4');
    assert.equal(res.json.phase, 'plan');
    assert.equal(ctx.spawns[0].command, 'claude');
    assert.ok(ctx.spawns[0].args.includes('--model'));
    assert.ok(ctx.spawns[0].args.includes('sonnet-4'));

    // Hostile /model injection is rejected by directive parser
    const hostile = parseCommentDirectives('/agent /model $(rm -rf /) hello');
    assert.equal(hostile.hasAgentPrefix, true);
    assert.equal(hostile.model, null);
  } finally {
    await ctx.cleanup();
  }
});

test('passes hostile shell-injection issue text strictly as data, never shell code', async () => {
  const ctx = await withTestServer();
  const pwnMarker = path.join(os.tmpdir(), `linear-runner-pwn-${crypto.randomUUID()}`);
  try {
    const hostilePayload = makeIssuePayload({
      url: `https://linear.app/acme/issue/ENG-666?x=$(touch ${pwnMarker})`,
      data: {
        identifier: `ENG-666; touch ${pwnMarker}`,
        title: `$(touch ${pwnMarker}) \`touch ${pwnMarker}\` '; rm -rf /; ' " && echo pwn`,
        description: `../../etc/passwd\n$(touch ${pwnMarker})\n'$(id)'\n"$(whoami)"\n\x00`,
        labels: [{ name: 'agent:claude' }, { name: 'plan' }],
      },
    });

    const res = await ctx.postWebhook(hostilePayload);
    assert.equal(res.status, 200);
    assert.equal(res.json.accepted, true);

    assert.equal(fs.existsSync(pwnMarker), false);
    assert.equal(ctx.spawns[0].cwd, ctx.repoDir);

    const { promptText } = ctx.store.loadJob(res.json.jobId);
    assert.ok(promptText.includes(`$(touch ${pwnMarker})`));
    assert.deepEqual(
      getLauncher('claude').buildArgs(promptText, { phase: 'plan' }),
      ['--print', '--output-format', 'json', '--permission-mode', 'plan', promptText]
    );
  } finally {
    if (fs.existsSync(pwnMarker)) fs.unlinkSync(pwnMarker);
    await ctx.cleanup();
  }
});

test('enables orchestrator delegation directive only when delegate label is present and routes repoMap', async () => {
  const extraRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-runner-extra-repo-'));
  const ctx = await withTestServer({
    repoMap: { APP: extraRepo },
    allowedRepoPaths: new Set([extraRepo]),
  });
  ctx.config.allowedRepoPaths.add(ctx.repoDir);
  try {
    const res = await ctx.postWebhook(
      makeIssuePayload({
        action: 'update',
        updatedFrom: { stateId: 'st-todo' },
        data: {
          identifier: 'APP-7',
          team: { key: 'APP' },
          state: { id: 'st-prog', name: 'In Progress' },
          labels: [{ name: 'agent' }, { name: 'delegate' }],
        },
      })
    );
    assert.equal(res.status, 200);
    assert.equal(res.json.delegate, true);
    assert.equal(ctx.spawns[0].cwd, extraRepo);
    const promptArg = ctx.spawns[0].args[ctx.spawns[0].args.length - 1];
    assert.ok(promptArg.includes('Orchestration & Delegation'));
  } finally {
    await ctx.cleanup();
    fs.rmSync(extraRepo, { recursive: true, force: true });
  }
});

test('parses and formats agy stream-json NDJSON output cleanly, stripping intermediate turns', () => {
  const agy = getLauncher('agy');
  const ndjson = [
    JSON.stringify({ event: 'init', conversation_id: 'conv-stream-1' }),
    JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 1, state: 'ACTIVE', step_type: 'thinking', thinking_delta: 'checking repo...' },
    }),
    JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: "I'm waiting for typecheck..." },
    }),
    JSON.stringify({
      event: 'step_update',
      step_update: { step_index: 5, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Final debrief: all checks passed.' },
    }),
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'conv-stream-1',
        status: 'SUCCESS',
        response: "I'm waiting for typecheck...\nFinal debrief: all checks passed.\n",
        duration_seconds: 2.5,
        usage: { total_tokens: 1200 },
      },
    }),
  ].join('\n');

  const parsed = agy.parseOutput(ndjson);
  assert.equal(parsed.conversationId, 'conv-stream-1');
  assert.equal(parsed.text, 'Final debrief: all checks passed.');

  const state = {};
  const lines = ndjson.split('\n').map((l) => agy.formatStreamLine(l, state)).filter(Boolean);
  assert.ok(lines.some((l) => l.includes('conv-stream-1')));
  assert.ok(lines.some((l) => l.includes('[thinking] checking repo...')));
  assert.ok(lines.some((l) => l.includes('Final debrief: all checks passed.')));
  assert.ok(lines.some((l) => l.includes('finished (SUCCESS, 2.5s, 1200 tokens)')));
});

test('moves ticket to Blocked (not In Review) when agent reports STATUS: BLOCKED', async () => {
  const ctx = await withTestServer(
    {},
    {
      spawnFn: async () => ({
        code: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({
          conversation_id: 'conv-blocked',
          response: 'STATUS: BLOCKED\nTypecheck failed in unrelated module.',
        }),
        stderr: '',
      }),
    }
  );
  try {
    const res = await ctx.postWebhook(
      makeIssuePayload({
        action: 'update',
        updatedFrom: { stateId: 'st-todo' },
        data: {
          state: { id: 'st-prog', name: 'In Progress' },
          labels: [{ name: 'agent' }],
        },
      })
    );
    assert.equal(res.status, 200);
    assert.equal(ctx.linearClient.commentsCreated.length, 1);
    assert.ok(ctx.linearClient.commentsCreated[0].body.includes('Implementation Blocked'));
    assert.equal(ctx.linearClient.reviewMoves.length, 0);
    assert.equal(ctx.linearClient.stateMoves.length, 1);
    assert.equal(ctx.linearClient.stateMoves[0].stateName, 'Blocked');
    assert.equal(ctx.linearClient.stateMoves[0].assigneeId, 'user-will');
  } finally {
    await ctx.cleanup();
  }
});

import http from 'node:http';
import { verifyLinearSignature, verifyWebhookTimestamp } from './verify.mjs';
import { JobStore } from './store.mjs';
import { buildPlanPrompt, buildImplementPrompt, buildReplyPrompt, extractIssueData } from './prompt.mjs';
import { resolveAgentForIssue } from './launchers/index.mjs';
import { parseCommentDirectives } from './directives.mjs';
import { JobRunner } from './runner.mjs';

const BOT_MARKER = '<!-- linear-runner:';

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > maxBytes) {
        aborted = true;
        const err = new Error('Payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Determines which workflow phase (if any) a Linear Issue webhook should trigger:
 * - "plan": Issue created, OR Issue updated with a label change
 * - "implement": Issue updated with a state change to IN_PROGRESS_STATE_NAME ("In Progress")
 */
export function resolvePhaseForEvent(payload, issue, { inProgressStateName = 'In Progress' } = {}) {
  if (payload.type !== 'Issue') return null;

  if (payload.action === 'create') {
    return 'plan';
  }

  if (payload.action === 'update' && payload.updatedFrom && typeof payload.updatedFrom === 'object') {
    const stateChanged = 'stateId' in payload.updatedFrom;
    if (
      stateChanged &&
      issue.stateName &&
      issue.stateName.toLowerCase() === inProgressStateName.toLowerCase()
    ) {
      return 'implement';
    }

    const labelsChanged = 'labelIds' in payload.updatedFrom || 'labels' in payload.updatedFrom;
    if (labelsChanged) {
      return 'plan';
    }
  }

  return null;
}

/**
 * Creates the local Linear webhook HTTP server.
 * Handles both Issue webhooks (Plan -> In Progress Implement) and Comment webhooks
 * (replies to bot comment threads OR standalone `/agent` comments).
 */
export function createWebhookServer(config, deps = {}) {
  const store = deps.store || new JobStore(config.dataDir);
  const nowFn = deps.now || (() => Date.now());
  const logger = deps.logger || console;
  const runner =
    deps.runner ||
    new JobRunner(config, {
      store,
      linearClient: deps.linearClient,
      spawnFn: deps.spawnFn,
      logger,
    });

  function resolveRepoPath(teamKey, fallbackRepoPath) {
    if (teamKey && config.repoMap && config.repoMap[teamKey]) {
      return config.repoMap[teamKey];
    }
    if (fallbackRepoPath && config.allowedRepoPaths?.has(fallbackRepoPath)) {
      return fallbackRepoPath;
    }
    return config.repoPath;
  }

  function handleCommentCreate(payload, deliveryId, res) {
    const data = payload?.data ?? {};
    const commentId = typeof data.id === 'string' ? data.id : '';
    const body = typeof data.body === 'string' ? data.body : '';
    const issueId =
      typeof data.issueId === 'string'
        ? data.issueId
        : typeof data.issue?.id === 'string'
          ? data.issue.id
          : '';
    const parentId =
      typeof data.parentId === 'string'
        ? data.parentId
        : typeof data.parent?.id === 'string'
          ? data.parent.id
          : '';

    if (!commentId || !issueId) {
      return sendJson(res, 400, { error: 'Missing commentId or issueId in Comment payload' });
    }

    // Loop protection: never trigger on comments posted by linear-runner itself
    if (body.includes(BOT_MARKER)) {
      return sendJson(res, 200, {
        accepted: false,
        ignored: true,
        reason: 'bot_comment',
      });
    }

    const threadSession = parentId ? store.getSessionByCommentId(parentId) : null;
    const directives = parseCommentDirectives(body);

    // Only trigger if:
    // 1. Replying to a specific comment thread owned by linear-runner, OR
    // 2. Starting a standalone comment with `/agent`
    if (!threadSession && !directives.hasAgentPrefix) {
      return sendJson(res, 200, {
        accepted: false,
        ignored: true,
        reason: 'not_agent_thread_or_prefix',
      });
    }

    const dup = store.isDuplicate({ deliveryId, commentId });
    if (dup.duplicate) {
      logger.log(`[webhook] Deduplicated comment ${commentId} (by=${dup.by})`);
      return sendJson(res, 200, {
        accepted: false,
        duplicate: true,
        existingJobId: dup.existingJobId,
      });
    }

    const issueSession = threadSession || store.getSessionByIssueId(issueId);
    const agent = directives.agent || threadSession?.agent || issueSession?.agent || config.defaultAgent;
    // Follow the thread's current phase: plan replies stay in plan mode until the user
    // moves the ticket to In Progress (or explicitly passes /implement). Replies to an
    // implementation debrief thread refine in implement mode.
    const phase =
      directives.phase ||
      (threadSession?.lastPhase === 'implement' ? 'implement' : 'plan');
    const model = directives.model || threadSession?.model || null;
    const canResume =
      Boolean(threadSession?.conversationId) &&
      (!directives.agent || directives.agent === threadSession.agent);
    const conversationId = canResume ? threadSession.conversationId : null;

    const identifier =
      typeof data.issue?.identifier === 'string' ? data.issue.identifier : issueId;
    const teamKey =
      typeof data.issue?.team?.key === 'string'
        ? data.issue.team.key.toUpperCase()
        : /^[A-Z][A-Z0-9]+-\d+$/.test(identifier)
          ? identifier.split('-')[0]
          : '';
    const repoPath = resolveRepoPath(teamKey, threadSession?.repoPath || issueSession?.repoPath);

    const replyAuthor = data.user?.displayName || data.user?.name || 'User';
    const issueStub = {
      id: issueId,
      identifier,
      title: typeof data.issue?.title === 'string' ? data.issue.title : '',
      description: '',
      url: typeof payload.url === 'string' ? payload.url : '',
      labels: [],
    };

    const replyText = directives.promptBody || body.trim();
    const promptText = buildReplyPrompt({
      issue: issueStub,
      replyText,
      authorName: replyAuthor,
      phase,
      delegate: directives.delegate,
      resumingSession: Boolean(conversationId),
    });

    const parentCommentId = threadSession?.rootCommentId || parentId || commentId;

    const { job } = store.saveJob({
      deliveryId,
      issue: issueStub,
      phase,
      trigger: threadSession ? 'thread_reply' : 'comment_command',
      agent,
      model,
      delegate: directives.delegate,
      repoPath,
      promptText,
      commentId,
      parentCommentId,
      replyText,
      replyAuthor,
      conversationId,
    });

    sendJson(res, 200, {
      accepted: true,
      jobId: job.jobId,
      identifier: job.identifier,
      phase: job.phase,
      trigger: job.trigger,
      agent: job.agent,
      model: job.model,
      delegate: job.delegate,
      resuming: Boolean(conversationId),
      dryRun: config.dryRun,
    });

    setImmediate(() => {
      runner.enqueue(job.jobId).catch((err) => {
        logger.error(`[webhook] Unhandled runner error for job ${job.jobId}:`, err.message);
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && urlPath === '/health') {
      return sendJson(res, 200, {
        ok: true,
        dryRun: config.dryRun,
        defaultAgent: config.defaultAgent,
        requiredLabel: config.requiredLabel || null,
        inProgressStateName: config.inProgressStateName,
        inReviewStateName: config.inReviewStateName,
      });
    }

    if (req.method !== 'POST' || urlPath !== '/linear') {
      return sendJson(res, 404, { error: 'Not found' });
    }

    let rawBody;
    try {
      rawBody = await readRawBody(req, config.maxBodyBytes);
    } catch (err) {
      if (err.code === 'PAYLOAD_TOO_LARGE') {
        return sendJson(res, 413, { error: 'Payload too large' });
      }
      return sendJson(res, 400, { error: 'Failed to read request body' });
    }

    const signatureHeader = req.headers['linear-signature'];
    const deliveryId =
      typeof req.headers['linear-delivery'] === 'string'
        ? req.headers['linear-delivery'].trim()
        : '';

    if (!verifyLinearSignature(rawBody, signatureHeader, config.webhookSecret)) {
      logger.warn(`[webhook] Rejected request with invalid Linear-Signature (delivery=${deliveryId || 'none'})`);
      return sendJson(res, 401, { error: 'Invalid signature' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }

    const tsCheck = verifyWebhookTimestamp(payload.webhookTimestamp, {
      now: nowFn(),
      maxAgeMs: config.maxTimestampAgeMs,
    });
    if (!tsCheck.ok) {
      logger.warn(`[webhook] Rejected stale/future webhookTimestamp: ${tsCheck.reason}`);
      return sendJson(res, 400, { error: 'Invalid webhookTimestamp', reason: tsCheck.reason });
    }

    // Comment create events (thread replies or `/agent` standalone comments)
    if (payload.type === 'Comment' && payload.action === 'create') {
      return handleCommentCreate(payload, deliveryId, res);
    }

    const issue = extractIssueData(payload);
    const phase = resolvePhaseForEvent(payload, issue, {
      inProgressStateName: config.inProgressStateName,
    });

    if (!phase) {
      return sendJson(res, 200, {
        accepted: false,
        ignored: true,
        reason: 'unsupported_event',
      });
    }

    if (!issue.id) {
      return sendJson(res, 400, { error: 'Missing issue id in payload' });
    }

    const routing = resolveAgentForIssue(issue.labels, {
      defaultAgent: config.defaultAgent,
      requiredLabel: config.requiredLabel,
      planLabel: config.planLabel,
      delegateLabel: config.delegateLabel,
    });
    if (!routing.matched) {
      return sendJson(res, 200, {
        accepted: false,
        ignored: true,
        reason: routing.reason,
      });
    }

    // Only run Phase 1 (Plan) if the issue carries the `plan` label.
    // Tickets with `agent` but without `plan` wait until moved to In Progress.
    if (phase === 'plan' && !routing.planRequested) {
      return sendJson(res, 200, {
        accepted: false,
        ignored: true,
        reason: 'missing_plan_label',
      });
    }

    const dup = store.isDuplicate({ deliveryId, issueId: issue.id, phase });
    if (dup.duplicate) {
      logger.log(
        `[webhook] Deduplicated ${issue.identifier} phase=${phase} (by=${dup.by}, existingJobId=${dup.existingJobId})`
      );
      return sendJson(res, 200, {
        accepted: false,
        duplicate: true,
        phase,
        existingJobId: dup.existingJobId,
      });
    }

    const repoPath = resolveRepoPath(issue.teamKey);
    const existingSession = phase === 'implement' ? store.getSessionByIssueId(issue.id) : null;
    const conversationId =
      existingSession && existingSession.agent === routing.agent
        ? existingSession.conversationId
        : null;

    const promptText =
      phase === 'plan'
        ? buildPlanPrompt(issue, { delegate: routing.delegate })
        : buildImplementPrompt(issue, [], { delegate: routing.delegate });

    const { job } = store.saveJob({
      deliveryId,
      issue,
      phase,
      trigger: 'issue',
      agent: routing.agent,
      delegate: routing.delegate,
      repoPath,
      promptText,
      conversationId,
    });

    // Return HTTP 200 promptly after securely persisting the job.
    sendJson(res, 200, {
      accepted: true,
      jobId: job.jobId,
      identifier: job.identifier,
      phase: job.phase,
      agent: job.agent,
      delegate: job.delegate,
      dryRun: config.dryRun,
    });

    // Run asynchronously on the concurrency-limited queue so Linear never waits.
    setImmediate(() => {
      runner.enqueue(job.jobId).catch((err) => {
        logger.error(`[webhook] Unhandled runner error for job ${job.jobId}:`, err.message);
      });
    });
  });

  return { server, store, runner };
}

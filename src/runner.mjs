import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getLauncher } from './launchers/index.mjs';
import { buildImplementPrompt, buildReplyPrompt } from './prompt.mjs';
import { LinearApiClient } from './linear-api.mjs';

function spawnAgentProcess({ command, args, cwd, logPath, timeoutMs, streamFormatLine, streamToTerminal = false }) {
  return new Promise((resolve, reject) => {
    const logStream = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    let lineBuf = '';
    const streamState = {};

    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000).unref();
          }, timeoutMs)
        : null;

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk);
      logStream.write(chunk);

      if (streamToTerminal) {
        if (streamFormatLine) {
          lineBuf += chunk.toString('utf8');
          const lines = lineBuf.split(/\r?\n/);
          lineBuf = lines.pop() ?? '';
          for (const line of lines) {
            const formatted = streamFormatLine(line, streamState);
            if (formatted) process.stdout.write(formatted);
          }
        } else {
          process.stdout.write(chunk);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
      logStream.write(chunk);
      if (streamToTerminal) {
        process.stderr.write(chunk);
      }
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      logStream.end();
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (streamToTerminal && streamFormatLine && lineBuf.trim()) {
        const formatted = streamFormatLine(lineBuf, streamState);
        if (formatted) process.stdout.write(formatted);
      }
      logStream.end();
      resolve({
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(stdoutChunks).toString('utf8').trim(),
        stderr: Buffer.concat(stderrChunks).toString('utf8').trim(),
      });
    });
  });
}

function formatPlanComment({ agent, body, isReply = false }) {
  const footer = isReply
    ? '_Reply in this thread to keep refining the plan, or move the ticket to **In Progress** when ready to implement._'
    : '_Reply in this thread to adjust any decisions or questions, then move this ticket to **In Progress** when ready to implement._';
  return [
    `<!-- linear-runner:plan agent=${agent} -->`,
    `### Implementation Plan (\`${agent}\`)`,
    '',
    body || '_(Agent produced empty output.)_',
    '',
    '---',
    footer,
  ].join('\n');
}

function formatDebriefComment({ agent, body, mention, blocked = false }) {
  const tagLine = blocked
    ? mention
      ? `${mention} Blocked — moved ticket to **Blocked** (checks or blockers need attention).`
      : 'Blocked — moved ticket to **Blocked** (checks or blockers need attention).'
    : mention
      ? `${mention} Ready for review.`
      : 'Ready for review.';
  const heading = blocked
    ? `### Implementation Blocked (\`${agent}\`)`
    : `### Implementation Debrief (\`${agent}\`)`;
  return [
    `<!-- linear-runner:debrief agent=${agent} blocked=${blocked} -->`,
    heading,
    '',
    tagLine,
    '',
    body || '_(Agent produced empty output.)_',
  ].join('\n');
}

function formatErrorComment({ agent, phase, errorMessage, logPath }) {
  return [
    `<!-- linear-runner:error phase=${phase} agent=${agent} -->`,
    `### Agent Run Failed (\`${agent}\` — ${phase})`,
    '',
    `Error: \`${errorMessage}\``,
    '',
    `Local log: \`${logPath}\``,
  ].join('\n');
}

function resolveConfiguredModel(config, agentName, phase, explicitModel) {
  if (explicitModel) return explicitModel;
  const agentModels = config.models?.[agentName];
  if (typeof agentModels === 'string') return agentModels;
  if (agentModels && typeof agentModels === 'object') {
    return agentModels[phase] || agentModels.default || null;
  }
  return null;
}

/**
 * Concurrency-limited headless job runner that executes Phase 1 (plan),
 * Phase 2 (implement), and threaded comment replies, posting results back to Linear.
 */
export class JobRunner {
  constructor(config, { store, linearClient, spawnFn = spawnAgentProcess, logger = console } = {}) {
    this.config = config;
    this.store = store;
    this.linear =
      linearClient || (config.linearApiKey ? new LinearApiClient(config.linearApiKey) : null);
    this.spawnFn = spawnFn;
    this.logger = logger;
    this.queue = [];
    this.activeCount = 0;
  }

  enqueue(jobId) {
    return new Promise((resolve, reject) => {
      this.queue.push({ jobId, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    const limit = Math.max(1, this.config.maxConcurrentJobs || 1);
    while (this.activeCount < limit && this.queue.length > 0) {
      const item = this.queue.shift();
      this.activeCount += 1;
      this.runJob(item.jobId)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.activeCount -= 1;
          this._drain();
        });
    }
  }

  async runJob(jobId) {
    const { job, promptText: initialPrompt, jobDir } = this.store.loadJob(jobId);
    const launcher = getLauncher(job.agent);
    const model = resolveConfiguredModel(this.config, launcher.name, job.phase, job.model);

    // Enforce trusted allowlist for repoPath
    const candidateRepo = job.repoPath ? path.resolve(job.repoPath) : this.config.repoPath;
    const repoPath = this.config.allowedRepoPaths.has(candidateRepo)
      ? candidateRepo
      : this.config.repoPath;

    const logPath = path.join(jobDir, 'output.log');
    const outputMessagePath = path.join(jobDir, 'last-message.txt');
    const isCommentTrigger = job.trigger === 'thread_reply' || job.trigger === 'comment_command';
    const replyParentId = isCommentTrigger ? job.parentCommentId : undefined;

    if (this.config.dryRun) {
      const previewArgs = launcher.buildArgs('<prompt>', {
        phase: job.phase,
        model,
        conversationId: job.conversationId,
        outputMessagePath,
      });
      this.logger.log(
        `[dry-run] Would run ${job.phase} (${job.trigger || 'issue'}) for ${job.identifier} (${job.jobId}) using "${launcher.name}" in ${repoPath}`
      );
      this.logger.log(`[dry-run] Command: ${launcher.command} ${previewArgs.join(' ')}`);
      this.store.updateStatus(jobId, 'dry_run');
      return { status: 'dry_run', phase: job.phase, agent: launcher.name, model, repoPath };
    }

    if (!this.linear) {
      throw new Error('LINEAR_API_KEY is not configured');
    }

    this.store.updateStatus(jobId, 'running');
    this.logger.log(
      `[runner] Starting ${job.phase} (${job.trigger || 'issue'}) for ${job.identifier} (${job.jobId}) with ${launcher.name}${model ? ` [${model}]` : ''}${job.conversationId ? ` (resuming ${job.conversationId})` : ''}`
    );

    let promptText = initialPrompt;
    let linearIssue = null;

    try {
      // Fetch full Linear issue + comments when implementing or starting a fresh comment thread
      if (job.phase === 'implement' || (isCommentTrigger && !job.conversationId)) {
        linearIssue = await this.linear.getIssueWithComments(job.issueId);
        const comments = linearIssue?.comments?.nodes || [];
        const liveLabels = (linearIssue?.labels?.nodes || [])
          .map((l) => l?.name)
          .filter((n) => typeof n === 'string');
        const delegateLabel = (this.config.delegateLabel || 'delegate').toLowerCase();
        const delegateEnabled =
          Boolean(job.delegate) ||
          (Boolean(delegateLabel) && liveLabels.some((l) => l.toLowerCase() === delegateLabel));

        const issueInfo = {
          id: linearIssue.id,
          identifier: linearIssue.identifier || job.identifier,
          title: linearIssue.title || job.title,
          description: linearIssue.description || '',
          url: linearIssue.url || job.url,
        };

        if (isCommentTrigger) {
          promptText = buildReplyPrompt({
            issue: issueInfo,
            replyText: job.replyText || '',
            authorName: job.replyAuthor || 'User',
            phase: job.phase,
            delegate: delegateEnabled,
            resumingSession: Boolean(job.conversationId),
            comments,
          });
        } else {
          promptText = buildImplementPrompt(issueInfo, comments, { delegate: delegateEnabled });
        }
        this.store.savePrompt(jobId, promptText);
      }

      const args = launcher.buildArgs(promptText, {
        phase: job.phase,
        model,
        conversationId: job.conversationId,
        outputMessagePath,
      });

      const result = await this.spawnFn({
        command: launcher.command,
        args,
        cwd: repoPath,
        logPath,
        timeoutMs: this.config.jobTimeoutMs,
        streamFormatLine: launcher.formatStreamLine || null,
        streamToTerminal: this.logger === console,
      });

      if (result.timedOut) {
        throw new Error(`Agent timed out after ${Math.round(this.config.jobTimeoutMs / 1000)}s`);
      }
      if (result.code !== 0) {
        throw new Error(
          `Agent exited with code ${result.code}${result.stderr ? `: ${result.stderr.slice(0, 300)}` : ''}`
        );
      }

      const parsed = launcher.parseOutput
        ? launcher.parseOutput(result.stdout, outputMessagePath)
        : { text: result.stdout, conversationId: null };
      const agentOutput = parsed.text;
      const nextConversationId = parsed.conversationId || job.conversationId || null;

      if (job.phase === 'plan') {
        const commentBody = formatPlanComment({
          agent: launcher.name,
          body: agentOutput,
          isReply: isCommentTrigger,
        });
        const posted = await this.linear.createComment(job.issueId, commentBody, {
          parentId: replyParentId,
        });
        this.store.recordSession({
          commentId: posted?.id,
          rootCommentId: replyParentId || posted?.id,
          issueId: job.issueId,
          agent: launcher.name,
          conversationId: nextConversationId,
          model,
          repoPath,
          lastPhase: 'plan',
        });
        this.store.updateStatus(jobId, 'completed', {
          conversationId: nextConversationId,
          postedCommentId: posted?.id || null,
        });
        this.logger.log(`[runner] Posted plan comment for ${job.identifier} (${job.jobId})`);
        return {
          status: 'completed',
          phase: 'plan',
          agent: launcher.name,
          conversationId: nextConversationId,
        };
      }

      // Phase 2 / Implement: post debrief tagging user; only move to In Review if not blocked
      const isBlocked = /(?:^|\n)\s*STATUS:\s*BLOCKED\b/i.test(agentOutput);
      const viewer = await this.linear.getViewer();
      const mention =
        this.config.reviewMention ||
        (viewer?.displayName ? `@${viewer.displayName}` : viewer?.name ? `@${viewer.name}` : '');

      const debriefBody = formatDebriefComment({
        agent: launcher.name,
        body: agentOutput,
        mention,
        blocked: isBlocked,
      });
      const posted = await this.linear.createComment(job.issueId, debriefBody, {
        parentId: replyParentId,
      });

      this.store.recordSession({
        commentId: posted?.id,
        rootCommentId: replyParentId || posted?.id,
        issueId: job.issueId,
        agent: launcher.name,
        conversationId: nextConversationId,
        model,
        repoPath,
        lastPhase: 'implement',
      });

      if (!linearIssue) {
        linearIssue = await this.linear.getIssueWithComments(job.issueId);
      }
      if (isBlocked) {
        await this.linear.moveIssueToState({
          issue: linearIssue,
          stateName: this.config.blockedStateName || 'Blocked',
          assigneeId: viewer?.id,
        });
      } else {
        await this.linear.moveIssueToReview({
          issue: linearIssue,
          stateName: this.config.inReviewStateName,
          assigneeId: viewer?.id,
        });
      }

      this.store.updateStatus(jobId, isBlocked ? 'blocked' : 'completed', {
        conversationId: nextConversationId,
        postedCommentId: posted?.id || null,
      });
      this.logger.log(
        isBlocked
          ? `[runner] Posted BLOCKED debrief and moved ${job.identifier} to "${this.config.blockedStateName || 'Blocked'}"`
          : `[runner] Posted debrief, moved ${job.identifier} to "${this.config.inReviewStateName}", and assigned to ${viewer?.displayName || viewer?.name || 'viewer'}`
      );
      return {
        status: isBlocked ? 'blocked' : 'completed',
        phase: 'implement',
        agent: launcher.name,
        conversationId: nextConversationId,
      };
    } catch (err) {
      this.logger.error(`[runner] Job ${job.jobId} (${job.identifier} ${job.phase}) failed:`, err.message);
      this.store.updateStatus(jobId, 'failed', { error: err.message });
      try {
        await this.linear.createComment(
          job.issueId,
          formatErrorComment({
            agent: launcher.name,
            phase: job.phase,
            errorMessage: err.message,
            logPath,
          }),
          { parentId: replyParentId }
        );
      } catch (commentErr) {
        this.logger.error(`[runner] Failed to post error comment to Linear:`, commentErr.message);
      }
      return { status: 'failed', phase: job.phase, error: err.message };
    }
  }
}

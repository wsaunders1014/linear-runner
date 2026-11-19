import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function atomicWriteFileSync(targetPath, content, mode = 0o600) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${targetPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
  fs.renameSync(tmpPath, targetPath);
}

export class JobStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.jobsDir = path.join(dataDir, 'jobs');
    this.dedupPath = path.join(dataDir, 'dedup.json');
    this.sessionsPath = path.join(dataDir, 'sessions.json');
    fs.mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    this.seen = this._loadDedup();
    this.sessions = this._loadSessions();
  }

  _loadDedup() {
    if (!fs.existsSync(this.dedupPath)) {
      return { deliveries: {}, issuePhases: {}, comments: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.dedupPath, 'utf8'));
      return {
        deliveries: parsed.deliveries && typeof parsed.deliveries === 'object' ? parsed.deliveries : {},
        issuePhases:
          parsed.issuePhases && typeof parsed.issuePhases === 'object'
            ? parsed.issuePhases
            : parsed.issues && typeof parsed.issues === 'object'
              ? parsed.issues
              : {},
        comments: parsed.comments && typeof parsed.comments === 'object' ? parsed.comments : {},
      };
    } catch {
      return { deliveries: {}, issuePhases: {}, comments: {} };
    }
  }

  _saveDedup() {
    atomicWriteFileSync(this.dedupPath, JSON.stringify(this.seen, null, 2));
  }

  _loadSessions() {
    if (!fs.existsSync(this.sessionsPath)) {
      return { byCommentId: {}, byIssueId: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sessionsPath, 'utf8'));
      return {
        byCommentId: parsed.byCommentId && typeof parsed.byCommentId === 'object' ? parsed.byCommentId : {},
        byIssueId: parsed.byIssueId && typeof parsed.byIssueId === 'object' ? parsed.byIssueId : {},
      };
    } catch {
      return { byCommentId: {}, byIssueId: {} };
    }
  }

  _saveSessions() {
    atomicWriteFileSync(this.sessionsPath, JSON.stringify(this.sessions, null, 2));
  }

  getSessionByCommentId(commentId) {
    if (!commentId) return null;
    return this.sessions.byCommentId[commentId] || null;
  }

  getSessionByIssueId(issueId) {
    if (!issueId) return null;
    return this.sessions.byIssueId[issueId] || null;
  }

  /**
   * Records a bot-posted Linear comment and associates it (plus its thread root and issue)
   * with the agent + conversationId so replies to that thread resume the exact session.
   */
  recordSession({ commentId, rootCommentId, issueId, agent, conversationId, model, repoPath, lastPhase }) {
    const effectiveRoot = rootCommentId || commentId;
    const record = {
      issueId,
      rootCommentId: effectiveRoot,
      agent,
      conversationId: conversationId || null,
      model: model || null,
      repoPath: repoPath || null,
      lastPhase: lastPhase || null,
      updatedAt: new Date().toISOString(),
    };
    if (commentId) {
      this.sessions.byCommentId[commentId] = record;
    }
    if (effectiveRoot) {
      this.sessions.byCommentId[effectiveRoot] = record;
    }
    if (issueId) {
      this.sessions.byIssueId[issueId] = record;
    }
    this._saveSessions();
    return record;
  }

  _issuePhaseKey(issueId, phase) {
    return `${issueId}:${phase}`;
  }

  isDuplicate({ deliveryId, issueId, phase = 'plan', commentId }) {
    if (deliveryId && this.seen.deliveries[deliveryId]) {
      return { duplicate: true, existingJobId: this.seen.deliveries[deliveryId], by: 'delivery' };
    }
    if (commentId) {
      if (this.seen.comments[commentId]) {
        return { duplicate: true, existingJobId: this.seen.comments[commentId], by: 'comment' };
      }
      return { duplicate: false };
    }
    if (issueId) {
      const key = this._issuePhaseKey(issueId, phase);
      if (this.seen.issuePhases[key]) {
        return { duplicate: true, existingJobId: this.seen.issuePhases[key], by: 'issue_phase' };
      }
    }
    return { duplicate: false };
  }

  /**
   * Persists the job metadata and prompt text atomically, and records deduplication keys.
   */
  saveJob({
    deliveryId,
    issue,
    phase = 'plan',
    trigger = 'issue',
    agent,
    model = null,
    delegate = false,
    repoPath,
    promptText,
    commentId = null,
    parentCommentId = null,
    replyText = null,
    replyAuthor = null,
    conversationId = null,
  }) {
    const jobId = crypto.randomUUID();
    const jobDir = path.join(this.jobsDir, jobId);
    fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });

    const job = {
      jobId,
      deliveryId: deliveryId || null,
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      labels: issue.labels,
      phase,
      trigger,
      agent,
      model,
      delegate: Boolean(delegate),
      repoPath,
      commentId,
      parentCommentId,
      replyText,
      replyAuthor,
      conversationId,
      createdAt: new Date().toISOString(),
      status: 'queued',
    };

    const jobJsonPath = path.join(jobDir, 'job.json');
    const promptPath = path.join(jobDir, 'prompt.txt');

    atomicWriteFileSync(promptPath, promptText);
    atomicWriteFileSync(jobJsonPath, JSON.stringify(job, null, 2));

    if (deliveryId) {
      this.seen.deliveries[deliveryId] = jobId;
    }
    if (commentId) {
      this.seen.comments[commentId] = jobId;
    } else if (issue.id) {
      this.seen.issuePhases[this._issuePhaseKey(issue.id, phase)] = jobId;
    }
    this._saveDedup();

    return { job, jobDir, jobJsonPath, promptPath };
  }

  savePrompt(jobId, promptText) {
    if (typeof jobId !== 'string' || !UUID_RE.test(jobId)) {
      throw new Error(`Invalid jobId format: ${jobId}`);
    }
    atomicWriteFileSync(path.join(this.jobsDir, jobId, 'prompt.txt'), promptText);
  }

  loadJob(jobId) {
    if (typeof jobId !== 'string' || !UUID_RE.test(jobId)) {
      throw new Error(`Invalid jobId format: ${jobId}`);
    }
    const jobDir = path.join(this.jobsDir, jobId);
    const job = JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
    const promptText = fs.readFileSync(path.join(jobDir, 'prompt.txt'), 'utf8');
    return { job, promptText, jobDir };
  }

  updateStatus(jobId, status, extra = {}) {
    if (typeof jobId !== 'string' || !UUID_RE.test(jobId)) {
      throw new Error(`Invalid jobId format: ${jobId}`);
    }
    const jobJsonPath = path.join(this.jobsDir, jobId, 'job.json');
    const current = JSON.parse(fs.readFileSync(jobJsonPath, 'utf8'));
    const updated = {
      ...current,
      ...extra,
      status,
      updatedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(jobJsonPath, JSON.stringify(updated, null, 2));
    return updated;
  }
}

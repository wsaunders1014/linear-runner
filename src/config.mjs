import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * Minimal zero-dependency .env loader. Existing process.env values take precedence.
 */
export function loadDotEnv(envPath = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export function loadConfig(overrides = {}) {
  loadDotEnv();
  const env = { ...process.env, ...overrides };

  const webhookSecret = env.LINEAR_WEBHOOK_SECRET || '';
  const linearApiKey = env.LINEAR_API_KEY || '';
  const repoPath = env.REPO_PATH || '';
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 8787);
  const defaultAgent = (env.DEFAULT_AGENT || 'agy').toLowerCase();
  const requiredLabel = env.REQUIRED_LABEL !== undefined ? env.REQUIRED_LABEL.trim() : 'agent';
  const planLabel = env.PLAN_LABEL !== undefined ? env.PLAN_LABEL.trim() : 'plan';
  const delegateLabel = env.DELEGATE_LABEL !== undefined ? env.DELEGATE_LABEL.trim() : 'delegate';
  const inProgressStateName = (env.IN_PROGRESS_STATE_NAME || 'In Progress').trim();
  const inReviewStateName = (env.IN_REVIEW_STATE_NAME || 'In Review').trim();
  const reviewMention = (env.REVIEW_MENTION || '').trim();
  const dryRun = env.DRY_RUN === 'true' || env.DRY_RUN === '1' || overrides.dryRun === true;
  const dataDir = env.DATA_DIR || path.join(ROOT_DIR, 'data');
  const maxBodyBytes = Number(env.MAX_BODY_BYTES || 1024 * 1024); // 1 MiB
  const maxTimestampAgeMs = Number(env.MAX_TIMESTAMP_AGE_MS || 60_000); // 60 seconds
  const maxConcurrentJobs = Number(env.MAX_CONCURRENT_JOBS || 1);
  const jobTimeoutMs = Number(env.JOB_TIMEOUT_MS || 30 * 60_000); // 30 minutes
  const repoMapPath = env.REPO_MAP_PATH || path.join(ROOT_DIR, 'repos.json');
  const runnerConfigPath = env.CONFIG_PATH || path.join(ROOT_DIR, 'config.json');

  let fileConfig = {};
  if (overrides.fileConfig && typeof overrides.fileConfig === 'object') {
    fileConfig = overrides.fileConfig;
  } else if (fs.existsSync(runnerConfigPath)) {
    const parsed = JSON.parse(fs.readFileSync(runnerConfigPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      fileConfig = parsed;
    }
  }

  if (!webhookSecret) {
    throw new Error('LINEAR_WEBHOOK_SECRET is required');
  }
  if (!dryRun && !linearApiKey) {
    throw new Error('LINEAR_API_KEY is required when DRY_RUN is false (needed to post comments and update issue status)');
  }
  if (!repoPath || !path.isAbsolute(repoPath)) {
    throw new Error('REPO_PATH must be a configured absolute path');
  }
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
    throw new Error(`REPO_PATH does not exist or is not a directory: ${repoPath}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  const repoMap = {};
  if (fileConfig.repos && typeof fileConfig.repos === 'object') {
    Object.assign(repoMap, fileConfig.repos);
  }
  if (overrides.repoMap && typeof overrides.repoMap === 'object') {
    Object.assign(repoMap, overrides.repoMap);
  } else if (fs.existsSync(repoMapPath)) {
    const parsed = JSON.parse(fs.readFileSync(repoMapPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      Object.assign(repoMap, parsed);
    }
  }

  const models =
    overrides.models && typeof overrides.models === 'object'
      ? overrides.models
      : fileConfig.models && typeof fileConfig.models === 'object'
        ? fileConfig.models
        : {};

  const resolvedDefaultAgent = (
    env.DEFAULT_AGENT ||
    (typeof fileConfig.defaultAgent === 'string' ? fileConfig.defaultAgent : '') ||
    defaultAgent
  ).toLowerCase();

  const normalizedRepoMap = {};
  const allowedRepoPaths = new Set([path.resolve(repoPath)]);
  for (const [teamKey, targetPath] of Object.entries(repoMap)) {
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
      throw new Error(`repos.json path for "${teamKey}" must be an absolute path`);
    }
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      throw new Error(`repos.json path for "${teamKey}" does not exist or is not a directory: ${targetPath}`);
    }
    const resolved = path.resolve(targetPath);
    normalizedRepoMap[teamKey.toUpperCase()] = resolved;
    allowedRepoPaths.add(resolved);
  }

  return {
    rootDir: ROOT_DIR,
    webhookSecret,
    linearApiKey,
    repoPath: path.resolve(repoPath),
    repoMap: normalizedRepoMap,
    allowedRepoPaths,
    host,
    port,
    defaultAgent: resolvedDefaultAgent,
    models,
    requiredLabel,
    planLabel,
    delegateLabel,
    inProgressStateName,
    inReviewStateName,
    reviewMention,
    dryRun,
    dataDir,
    maxBodyBytes,
    maxTimestampAgeMs,
    maxConcurrentJobs,
    jobTimeoutMs,
  };
}

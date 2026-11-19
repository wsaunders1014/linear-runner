#!/usr/bin/env node
import { loadConfig } from '../src/config.mjs';
import { JobStore, UUID_RE } from '../src/store.mjs';
import { JobRunner } from '../src/runner.mjs';

const jobId = process.argv[2];
if (!jobId || !UUID_RE.test(jobId)) {
  console.error('Usage: run-job.mjs <valid-job-uuid>');
  process.exit(1);
}

const config = loadConfig();
const store = new JobStore(config.dataDir);
const runner = new JobRunner(config, { store });

const result = await runner.runJob(jobId);
console.log(JSON.stringify(result, null, 2));
if (result.status === 'failed') {
  process.exit(1);
}

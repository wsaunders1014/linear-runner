import { loadConfig } from './config.mjs';
import { getLauncher } from './launchers/index.mjs';
import { createWebhookServer } from './server.mjs';

const args = new Set(process.argv.slice(2));
const dryRunFlag = args.has('--dry-run');

const config = loadConfig(dryRunFlag ? { dryRun: true } : {});
// Validate configured default agent early on startup
getLauncher(config.defaultAgent);

const { server } = createWebhookServer(config);

server.listen(config.port, config.host, () => {
  console.log(`linear-runner listening on http://${config.host}:${config.port}/linear`);
  console.log(`  repoPath:       ${config.repoPath}`);
  console.log(`  defaultAgent:   ${config.defaultAgent}`);
  console.log(`  requiredLabel:  ${config.requiredLabel || '(none - all Issue events)'}`);
  console.log(`  implementState: ${config.inProgressStateName} -> ${config.inReviewStateName}`);
  console.log(`  maxConcurrent:  ${config.maxConcurrentJobs}`);
  console.log(`  dryRun:         ${config.dryRun}`);
});

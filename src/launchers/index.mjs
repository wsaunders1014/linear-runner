import { agyLauncher } from './agy.mjs';
import { claudeLauncher } from './claude.mjs';
import { codexLauncher } from './codex.mjs';

export const LAUNCHERS = Object.freeze({
  agy: agyLauncher,
  claude: claudeLauncher,
  codex: codexLauncher,
});

export function getLauncher(agentName) {
  const key = String(agentName || '').toLowerCase();
  const launcher = LAUNCHERS[key];
  if (!launcher) {
    throw new Error(
      `Unsupported agent launcher: "${agentName}". Valid options: ${Object.keys(LAUNCHERS).join(', ')}`
    );
  }
  return launcher;
}

/**
 * Checks whether an issue's labels satisfy REQUIRED_LABEL (or any agent:<name> label),
 * resolves which agent should run it, and checks whether delegation is enabled.
 */
export function resolveAgentForIssue(
  labels,
  {
    defaultAgent = 'agy',
    requiredLabel = 'agent',
    planLabel = 'plan',
    delegateLabel = 'delegate',
  } = {}
) {
  const normalized = labels.map((l) => l.toLowerCase());
  const delegate = Boolean(delegateLabel) && normalized.includes(delegateLabel.toLowerCase());
  const planRequested = !planLabel || normalized.includes(planLabel.toLowerCase());

  // Check explicit per-agent label override: agent:agy, agent:claude, agent:codex
  for (const label of normalized) {
    if (label.startsWith('agent:')) {
      const candidate = label.slice('agent:'.length);
      if (candidate in LAUNCHERS) {
        return { matched: true, agent: candidate, matchedLabel: label, planRequested, delegate };
      }
    }
  }

  // If a required label is configured, the issue must carry it
  if (requiredLabel) {
    const req = requiredLabel.toLowerCase();
    if (!normalized.includes(req)) {
      return {
        matched: false,
        agent: null,
        planRequested: false,
        delegate: false,
        reason: 'missing_required_label',
      };
    }
  }

  const resolved = getLauncher(defaultAgent).name;
  return {
    matched: true,
    agent: resolved,
    matchedLabel: requiredLabel || null,
    planRequested,
    delegate,
  };
}

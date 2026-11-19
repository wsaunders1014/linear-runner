const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const VALID_AGENTS = new Set(['agy', 'claude', 'codex']);

/**
 * Parses optional leading inline directives from a Linear comment body.
 * Supported directives (only parsed at the start of the comment):
 *   /agent                   - triggers the runner from a standalone comment
 *   /model <model-id>        - overrides the model for this run (validated)
 *   /agy | /claude | /codex  - overrides the agent CLI for this run
 *   /delegate                - enables orchestrator delegation for this run
 *   /plan                    - forces read-only plan mode for this run
 *   /implement               - forces implementation mode for this run
 *
 * All directives are stripped from promptBody; untrusted values are strictly validated.
 */
export function parseCommentDirectives(rawBody) {
  const text = typeof rawBody === 'string' ? rawBody.trim() : '';
  let rest = text;

  let hasAgentPrefix = false;
  let agent = null;
  let model = null;
  let delegate = false;
  let phase = null;

  // Repeatedly consume leading slash directives
  while (rest.startsWith('/')) {
    const match = rest.match(/^\/([a-z]+)(?:\s+([^\s]+))?/i);
    if (!match) break;

    const cmd = match[1].toLowerCase();
    const arg = match[2] || '';

    if (cmd === 'agent') {
      hasAgentPrefix = true;
      rest = rest.slice('/agent'.length).trimStart();
      continue;
    }

    if (VALID_AGENTS.has(cmd)) {
      agent = cmd;
      rest = rest.slice(cmd.length + 1).trimStart();
      continue;
    }

    if (cmd === 'delegate') {
      delegate = true;
      rest = rest.slice('/delegate'.length).trimStart();
      continue;
    }

    if (cmd === 'plan') {
      phase = 'plan';
      rest = rest.slice('/plan'.length).trimStart();
      continue;
    }

    if (cmd === 'implement') {
      phase = 'implement';
      rest = rest.slice('/implement'.length).trimStart();
      continue;
    }

    if (cmd === 'model') {
      if (arg && MODEL_ID_RE.test(arg)) {
        model = arg;
        rest = rest.slice(match[0].length).trimStart();
      } else {
        // Consume only `/model` if argument is missing or invalid; never pass unsafe model IDs
        rest = rest.slice('/model'.length).trimStart();
      }
      continue;
    }

    // Unknown slash token: stop parsing directives and keep the rest as prompt text
    break;
  }

  return {
    hasAgentPrefix,
    agent,
    model,
    delegate,
    phase,
    promptBody: rest.trim(),
  };
}

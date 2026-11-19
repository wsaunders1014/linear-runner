export const agyLauncher = {
  name: 'agy',
  command: 'agy',
  /**
   * Builds headless auto-approved argv for Antigravity CLI.
   * Uses --output-format stream-json so we can stream live thinking/tools/text
   * to the terminal while capturing conversation_id and final response.
   * Prompt text is attached to --print=<prompt> as a single argv element (never via shell).
   */
  buildArgs(promptText, { phase = 'plan', model = null, conversationId = null } = {}) {
    const args = [];
    if (phase === 'implement') {
      args.push('--mode', 'auto', '--dangerously-skip-permissions');
    } else {
      args.push('--mode', 'plan', '--dangerously-skip-permissions', '--sandbox');
    }
    if (model) {
      args.push('--model', model);
    }
    if (conversationId) {
      args.push('--conversation', conversationId);
    }
    args.push('--output-format', 'stream-json', `--print=${promptText}`);
    return args;
  },

  /**
   * Formats a single NDJSON line from `agy --output-format stream-json` for live terminal display.
   * Returns a string to write directly to stdout, or null to skip.
   */
  formatStreamLine(line, state = {}) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return `${trimmed}\n`;
    }

    if (obj.event === 'init') {
      return `\n[agy] session ${obj.conversation_id || '(unknown)'}\n`;
    }

    if (obj.event === 'step_update' && obj.step_update) {
      const su = obj.step_update;

      if (typeof su.thinking_delta === 'string' && su.thinking_delta.length > 0) {
        const prefix = state.lastSection !== 'thinking' ? '\n[thinking] ' : '';
        state.lastSection = 'thinking';
        return `${prefix}${su.thinking_delta}`;
      }

      if (typeof su.text_delta === 'string' && su.text_delta.length > 0) {
        const prefix = state.lastSection !== 'response' ? '\n[response]\n' : '';
        state.lastSection = 'response';
        return `${prefix}${su.text_delta}`;
      }

      if (su.step_type && su.step_type !== 'user_input' && su.step_type !== 'agent_response') {
        const key = `${su.step_index}:${su.step_type}:${su.state}`;
        if (su.state === 'ACTIVE' && state.lastToolKey !== key) {
          state.lastToolKey = key;
          state.lastSection = 'tool';
          const detail = su.tool_name || su.step_type;
          return `\n[tool] ${detail}...\n`;
        }
      }

      return null;
    }

    if (obj.event === 'result' && obj.result) {
      const dur =
        typeof obj.result.duration_seconds === 'number'
          ? `${obj.result.duration_seconds.toFixed(1)}s`
          : '';
      const tokens = obj.result.usage?.total_tokens
        ? `, ${obj.result.usage.total_tokens} tokens`
        : '';
      return `\n[agy] finished (${obj.result.status || 'DONE'}${dur ? `, ${dur}` : ''}${tokens})\n`;
    }

    return null;
  },

  /**
   * Parses `stream-json` NDJSON (or single JSON) output to extract the clean
   * final response and conversation_id for session resumption.
   */
  parseOutput(stdout) {
    const trimmed = (stdout || '').trim();
    if (!trimmed) return { text: '', conversationId: null };

    let conversationId = null;
    let finalResponse = null;
    const textDeltas = [];

    for (const rawLine of trimmed.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (typeof obj.conversation_id === 'string') {
        conversationId = obj.conversation_id;
      }
      if (obj.event === 'result' && obj.result) {
        if (typeof obj.result.conversation_id === 'string') {
          conversationId = obj.result.conversation_id;
        }
        if (typeof obj.result.response === 'string') {
          finalResponse = obj.result.response.trim();
        }
      } else if (obj.event === 'step_update' && typeof obj.step_update?.text_delta === 'string') {
        textDeltas.push(obj.step_update.text_delta);
      } else if (typeof obj.response === 'string') {
        // Fallback for single-object `--output-format json`
        finalResponse = obj.response.trim();
      }
    }

    if (finalResponse !== null) {
      return { text: finalResponse, conversationId };
    }
    if (textDeltas.length > 0) {
      return { text: textDeltas.join('').trim(), conversationId };
    }
    return { text: trimmed, conversationId };
  },
};

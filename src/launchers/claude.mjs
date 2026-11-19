export const claudeLauncher = {
  name: 'claude',
  command: 'claude',
  /**
   * Builds headless auto-approved argv for Claude Code (no model API keys;
   * uses the logged-in Claude CLI session).
   * Uses --output-format json so we capture session_id for thread replies.
   */
  buildArgs(promptText, { phase = 'plan', model = null, conversationId = null } = {}) {
    const args = ['--print', '--output-format', 'json'];
    if (phase === 'implement') {
      args.push('--permission-mode', 'auto');
    } else {
      args.push('--permission-mode', 'plan');
    }
    if (model) {
      args.push('--model', model);
    }
    if (conversationId) {
      args.push('--resume', conversationId);
    }
    args.push(promptText);
    return args;
  },

  parseOutput(stdout) {
    const trimmed = (stdout || '').trim();
    if (!trimmed) return { text: '', conversationId: null };
    try {
      const parsed = JSON.parse(trimmed);
      return {
        text: typeof parsed.result === 'string' ? parsed.result.trim() : trimmed,
        conversationId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
      };
    } catch {
      return { text: trimmed, conversationId: null };
    }
  },
};

import fs from 'node:fs';

export const codexLauncher = {
  name: 'codex',
  command: 'codex',
  usesOutputFile: true,
  /**
   * Builds headless auto-approved argv for Codex CLI (no model API keys;
   * uses the logged-in Codex CLI session).
   */
  buildArgs(promptText, { phase = 'plan', model = null, outputMessagePath } = {}) {
    const args = ['exec'];
    if (phase === 'implement') {
      args.push('--full-auto');
    } else {
      args.push('-s', 'read-only');
    }
    if (model) {
      args.push('-m', model);
    }
    if (outputMessagePath) {
      args.push('-o', outputMessagePath);
    }
    args.push(promptText);
    return args;
  },

  parseOutput(stdout, outputMessagePath) {
    if (outputMessagePath && fs.existsSync(outputMessagePath)) {
      const fileText = fs.readFileSync(outputMessagePath, 'utf8').trim();
      if (fileText) return { text: fileText, conversationId: null };
    }
    return { text: (stdout || '').trim(), conversationId: null };
  },
};

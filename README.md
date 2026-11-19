# linear-runner

A standalone, zero-dependency local Linear webhook runner in Node.js for an automated **Plan (optional) → Thread Discussion → Implement → Review** workflow using your local coding agents (`agy`, `claude`, or `codex`).

## Workflow

1. **Optional Plan (`agent` + `plan` label):**
   - When an issue has both `agent` (or `agent:<name>`) and `plan`, the agent investigates read-only, picks its **(Recommended)** choices for open questions, lists alternatives, and posts a plan comment.
   - Replying in **that comment thread** resumes the exact same agent conversation (`conversation_id` / `session_id`) in read-only plan mode—it refines the plan without editing files until you move the ticket to **In Progress**.
2. **Direct Implement (`agent` label, no `plan`):**
   - Tickets with `agent` but without `plan` do nothing on creation.
   - When you move the ticket to **In Progress**, the agent implements directly to the best of its ability, posts its findings, assumptions, and debrief tagging you (`@<your-name>`), and moves the ticket to **In Review**.
3. **Review & Refine via Comment Threads:**
   - Replying in an **implementation debrief** thread resumes the agent in implement mode to apply your refinements, post an updated debrief in the thread, and move/keep it in **In Review**.
   - Standalone human comments are ignored unless they start with `/agent` (so you can leave notes for yourself freely).
   - Optional leading inline directives in comments: `/model <id>`, `/agy`, `/claude`, `/codex`, `/delegate`, `/plan`, `/implement`.

## Model & Multi-Project Config (`config.json`)

Instead of managing lots of Linear labels, you can optionally create `~/linear-runner/config.json`:

```json
{
  "defaultAgent": "agy",
  "models": {
    "agy": {
      "plan": "gemini-4-neon-medium",
      "implement": "gemini-4-neon-high"
    },
    "claude": {
      "default": "sonnet"
    }
  },
  "repos": {
    "REV": "/Users/willsaunders/webdev/screenwriter"
  }
}
```

## Security model

- **Local-only by default:** Binds to `127.0.0.1:8787` (`POST /linear`).
- **Signature & replay protection:** Constant-time HMAC-SHA256 verification of `Linear-Signature` over raw body, rejects `webhookTimestamp` >60s old or in the future, deduplicates deliveries/issue-phases/comments.
- **Self-loop protection:** Ignores any comment containing `<!-- linear-runner:`.
- **No shell injection:** All issue/comment text is passed via `spawn(..., { shell: false })` `argv`; `/model` values are strictly allowlist-validated (`/^[a-z0-9][a-z0-9._-]{0,79}$/i`).
- **No LLM API keys:** Uses your logged-in `agy`, `claude`, or `codex` CLIs (`LINEAR_API_KEY` is only a Linear Personal API key for comments/status).

## Setup

1. `cp .env.example .env` and fill in `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY`, `REPO_PATH`, and `DRY_RUN=false`.
2. In **Linear → Settings → API → Webhooks**, check **Issues** and **Comments** (pointing to `https://<your-mac>.<tailnet>.ts.net/linear`).
3. Run tests: `npm test`
4. Start live: `npm start`

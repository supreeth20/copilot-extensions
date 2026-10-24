# Copilot extensions

Custom extensions for GitHub Copilot CLI.

## Context prune

Explicit, user-triggered context reduction with recoverable session history:

| Command | Behavior |
| --- | --- |
| `/context-drop-tools [focus]` | Replace tool calls/results with concise findings while deterministically retaining non-tool text and readable thinking. |
| `/context-compact [focus]` | Replace active context with a skill-guided working-state summary. |
| `/context-cancel` | Cancel an unapplied operation. |

Both reduction commands save an exact checkpoint before applying. Original session
history remains available through `context_history`. No duplicate transcript
archive is created.

### Install

Requires GitHub Copilot CLI with extension support. Tested with CLI 1.0.103;
compatibility with other versions is not guaranteed. The extension uses the SDK
provided by the CLI and has no additional package dependencies.

```sh
git clone https://github.com/supreeth20/copilot-extensions.git
cd copilot-extensions
mkdir -p ~/.copilot/extensions ~/.copilot/skills
cp -R extensions/context-prune ~/.copilot/extensions/
cp -R skills/context-compaction ~/.copilot/skills/
```

The copy commands replace matching files in an existing installation. Restart
Copilot CLI after installation.

**After each reduction**, run `/exit`, then the exact
`copilot --resume <same-session-id>` command printed by the extension. This resumes
the existing conversation; it does not create a new session.

### Limitations

Retained messages and readable thinking become labeled historical text, not native
message roles or restored private reasoning state. Tool-only mode refuses binary
attachments/results. Summary fidelity depends on the agent, and history cannot
recover expired artifacts that Copilot itself truncated.

See the [extension documentation](extensions/context-prune/README.md) for behavior,
safety checks, and recovery details.

### Test

Run the deterministic transformation and mocked-runtime regression tests with
Node.js:

```sh
node --test extensions/context-prune/context.test.mjs
```

The published suite contains 54 tests. Separate local live evaluations also
covered repeated/mixed reductions, recorded reasoning, actual slash commands,
history recovery, and same-session process resume. Private session journals and
local evaluation artifacts are intentionally not included.

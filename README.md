# Copilot extensions

Custom extensions for GitHub Copilot CLI.

## Context prune

Explicit, user-triggered context reduction with recoverable session history:

| Command | Behavior |
| --- | --- |
| `/context-drop-tools [focus]` | Replace tool calls/results with concise findings while deterministically retaining non-tool text and readable thinking. |
| `/context-compact [focus]` | Replace active context with a skill-guided working-state summary. |
| `/context-cancel` | Cancel an unapplied operation. |

Slash-command code owns snapshotting, generation, validation, checkpointing, and
application. An isolated, tool-free SDK worker only returns findings or a summary
as JSON; the main agent is never prompted to orchestrate the operation. No
model-authorized apply or custom history tool is exposed.

Both commands save and read-verify the exact replacement before applying.
Original session history remains available through native history queries and,
where permitted, the original session journal. No duplicate transcript archive
is created.

### Install

Requires GitHub Copilot CLI with extension support. Tested with CLI 1.0.103;
compatibility with other versions is not guaranteed. The extension uses the SDK
provided by the CLI and has no additional package dependencies. The installed
`copilot` executable must be on PATH, or set `COPILOT_CLI_PATH`.

```sh
git clone https://github.com/supreeth20/copilot-extensions.git
cd copilot-extensions
mkdir -p ~/.copilot/extensions ~/.copilot/skills
cp -R extensions/context-prune ~/.copilot/extensions/
cp -R skills/context-compaction ~/.copilot/skills/
```

The copy commands replace matching files in an existing installation. Restart
Copilot CLI after installation.

If extensions are not discovered, start with `copilot --experimental`. The SDK
requires a registered internal transition adapter; its descriptor is discoverable,
but only code can authorize it. See the extension documentation for that constraint.

**After each reduction**, run `/exit`, then the exact
`copilot --resume <same-session-id>` command printed by the extension. This resumes
the existing conversation; it does not create a new session.

### Limitations

Retained messages and readable thinking become labeled historical text, not native
message roles or restored private reasoning state. Tool-only mode refuses
attachments/binary results. Compaction includes recorded attachment text and
metadata, but its text-only worker cannot inspect binary bytes or read referenced
files; summaries must retain the relevant recovery references and evidence gaps.
Summary fidelity depends on the model, and history cannot
recover expired artifacts that Copilot itself truncated.

Generation uses the current model, context tier and reasoning effort with normal
Copilot authentication. Custom provider configurations are not copied; a
model/provider mismatch fails rather than silently switching providers.

See the [extension documentation](extensions/context-prune/README.md) for behavior,
safety checks, and recovery details.

### Test

Run the deterministic transformation and mocked-runtime regression tests with
Node.js:

```sh
node --test extensions/context-prune/*.test.mjs
```

Independent adversarial evaluations run with:

```sh
node --test evals/context-prune/independent.test.mjs
```

See [independent evaluation instructions](evals/context-prune/README.md) for
live SDK checks and explicitly classified upstream limitations. The combined
regression/independent suite has 112 passing tests; the code-owned live SDK runner
passes 121 checks, including four consecutive compactions with cold resumes.
The focused attachment compaction/cold-resume scenario passes 29 checks.
Separate local live evaluations also
covered repeated/mixed reductions, recorded reasoning, actual slash commands,
history recovery, and same-session process resume. Private session journals and
local evaluation artifacts are intentionally not included.

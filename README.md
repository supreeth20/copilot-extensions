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
message roles or restored private reasoning state. Both modes preserve attachment
references in code, independently of generated prose. Existing documents retain
their paths; recoverable pasted/binary bytes are saved privately under the session's
`files/context-prune-attachments/` directory. The continuing agent is instructed
to reread relevant files with an appropriate permitted tool before relying on
their contents. Original files may change or disappear, and absent bytes remain
explicit recovery gaps. The text-only generation worker cannot inspect these files.
Summary fidelity depends on the model, and history cannot
recover expired artifacts that Copilot itself truncated.

Native large-paste markers are parsed in code into the same reference list, so
their session-owned text paths do not depend on generated summaries. Recorded
image bytes are saved proactively even when the attachment also has a temporary
file path. Ordinary document paths are not copied or frozen. See the evaluation
documentation for recovery tests and the earlier native TUI observations.

**Native attachment restoration is not implemented in this extension.** Separate
SDK experiments show that stored PNG assets can be reattached by asset reference
or original bytes after clearing and restarting. That requires an additional
native attachment send, or an extension composer push forwarded by the host;
putting an asset ID in the retained text does not do it. The implementation instead
uses file-reference recovery, not composer replay. See the evaluation documentation
and `evals/context-prune/preservation-gaps.json` for the tested scope and remaining gaps.

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
regression/independent suite has 140 passing tests. The focused attachment-path
scenario passes 63 real SDK/model checks, including recovering a deleted image
source from recorded bytes and rereading native pasted text after drop, two
compactions and cold resumes. The earlier
code-owned runner passed 121 repeated-reduction checks, including four consecutive
compactions; that is a historical result, not a rerun of the latest change.
Separate local live evaluations also
covered repeated/mixed reductions, recorded reasoning, actual slash commands,
history recovery, and same-session process resume. Private session journals and
local evaluation artifacts are intentionally not included.

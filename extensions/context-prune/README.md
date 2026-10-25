# Context prune

User-triggered, code-orchestrated context reduction for Copilot CLI 1.0.103.

| Command | Effect |
| --- | --- |
| `/context-drop-tools [focus]` | Replace tool evidence with findings, deterministically preserving non-tool text and readable thinking. |
| `/context-compact [focus]` | Replace active context with a skill-guided working-state summary. |
| `/context-cancel` | Cancel before context clearing starts. |

## Ownership

Each reduction command performs this pipeline in SDK code:

1. Refuse busy/unsafe state and snapshot the existing journal's event IDs.
2. Prepare durable attachment references, then ask an isolated, tool-free SDK
   worker for structured JSON text.
3. Recheck state and validate the returned findings or six-section summary.
4. Assemble the replacement deterministically, save an exact checkpoint, and read-verify it.
5. Recheck the snapshot, apply the replacement, and print same-session reload instructions.

The main agent receives no preparation prompt and makes no orchestration calls.
Drop mode supplies only tool evidence to its worker, not narrative to rewrite.
Only compact mode loads the `context-compaction` skill. The skill governs text
content, not checkpointing, recovery, or application.

The production code has five modules: `extension.mjs` wires the SDK,
`runtime.mjs` owns the command pipeline, `generation.mjs` owns isolated workers,
`attachments.mjs` prepares durable file references, and `context.mjs` projects/replays
recorded context. `test-support/history.mjs`
is only an evaluation helper; production exposes and loads no custom history
search implementation. Legacy journal formats remain readable.

The SDK requires `history.clearContext` to run inside a tool handler and forbids
extension connections from dynamically replacing tools. One internal
`context_commit` adapter is therefore registered when the extension joins. Its
descriptor is deferred/discoverable, not hidden; there is no claim of zero tools
in the parent's catalog. Despite its name, it performs no Git commits.
It is inert without a command-owned, short-lived,
single-use authorization, exact random call ID/session/request scope and empty
arguments. Code invokes it directly with `session.rpc.tools.execute` and revokes
authorization afterward. The model cannot authorize or choose application. Other
clients' tools remain untouched. There is no `context_apply` or custom history
tool. Copilot may request session permission for the adapter's skip-prompt
capability when loading the extension.

Workers use a temporary isolated home/workspace, empty tool allowlist, rejected
permissions, and disabled extensions, discovery, hooks, shared session indexing,
skills and automatic compaction. They use the active model, context tier and
reasoning effort with normal Copilot authentication. Their selected configuration
is checked before generation; custom providers are not copied and a mismatch
fails explicitly. Workers are deleted and their owned runtimes stopped before
the replacement can be applied. Temporary workers are not replacement
conversations or handoff sessions.

The CLI executable is resolved from `COPILOT_CLI_PATH`, the Copilot host
executable, or PATH. No additional SDK/runtime package installation is required.

## Preservation and recovery

Tool-only mode preserves recorded message content, distinct transformed user
text, finalized readable reasoning and blocks, phase, citations, order and
within-representation repetition. Mirrored readable fields are not duplicated.
Opaque ciphertext, native reasoning IDs/signatures and transient streaming
deltas are not copied. Previous findings are retained exactly on later drops.
Legacy generated operation messages remain recognizable, but literal user
examples of their markers are ordinary prose.

`clearContext` takes one string, not native message edits: retained messages and
thinking become labeled historical text, not restored roles or private reasoning
state. Attachments are preserved as recoverable references, not native message
replays. Findings are limited to 12000 characters each; schema/coverage checks cannot
prove semantic completeness.

Compaction includes recorded attachment text and metadata, including selections,
paths/ranges, display names, extension context and provenance. Binary tool
descriptions, asset IDs and resource URIs remain available as recovery references;
inline binary payloads are not copied into text. The worker cannot inspect binary
bytes or read referenced files. The skill requires preserving relevant attachment
requirements and references, explicitly distinguishing missing/uninspected content
from verified evidence. Native attachment roles and visual content are not restored.

Both modes retain a code-owned attachment-reference list in the replacement and
exact checkpoint, so a model cannot accidentally omit paths from a summary.
Ordinary document paths are retained without reading or freezing their contents.
Relative paths are resolved against the session workspace's working directory.
Native `<pasted_content file="...">` markers in user messages are parsed
deterministically into this list without changing the original message; their
existing session-owned text files need no additional copy. The registry survives
subsequent reductions even if generated summaries omit every path.
Pasted bytes, binary tool results and recorded binary assets without a durable
file reference are saved as content-addressed files under the session workspace's
`files/context-prune-attachments/` directory, with private file permissions.
Recorded image bytes take precedence over an image attachment's file path, so
clipboard images are saved before clearing even if their temporary PNG is gone.
These files remain for later reductions/checkpoints and last as long as that
session workspace; they are not a separate transcript archive.

The continuing agent must reread relevant paths with a suitable permitted
document/image/file tool before relying on their contents. Files can change or
disappear; unknown formats may need a document reader, and missing original bytes
are explicitly marked unavailable. Saving bytes is neither inspection nor native
reattachment. Invalid bytes or persistence failures stop before clearing.
On later reductions, content-addressed saved copies are checked against their
recorded checksum regardless of format: corruption stops before clearing, and
missing copies are marked unavailable. Ordinary source files remain mutable;
their current contents are not required to match original attachment metadata.
Native composer replay is deliberately not used. Separate SDK experiments proved
PNG reattachment feasible, but actual TUI native-attachment restoration remains
unverified and is not required by this file-reference approach.

Original journals are never rewritten. The retained context instructs the agent
to query native session history (`session_store_sql`) when information is missing.
If indexing lacks raw tool evidence, use the existing journal or referenced
artifacts only where access is permitted. There is no custom recovery tool or
duplicate transcript archive. History cannot recover data Copilot never recorded
or spill files that have expired; absent outcomes remain unknown.

## Failure, cancellation and reload

Queued input, steering, active turns, unresolved tool/permission requests,
background tasks and native compaction block reduction. New journal events
invalidate the snapshot; only the exact code-owned transition request is exempt.
Invalid text or checkpoint readback aborts before clearing. `/context-cancel`
aborts generation/preparation, but cannot interrupt a clear already underway.

A checkpoint saved before a later failure remains available and is reported;
unrelated/native checkpoints are not deleted. An ambiguous clear or post-clear
failure requires reload rather than an unsafe retry. Checkpoints are custom
persistence, not native compaction-counter entries.

**After each successful reduction:** run `/exit`, then the exact
`copilot --resume <same-session-id>` command printed by the extension. This
continues the existing conversation. This CLI can retain stale live messages
after clearing, so do not continue task work before reloading.

## Skill and tests

The original compact skill combines working-state retention and observation
masking from [Agent Skills for Context Engineering](https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering),
coverage discipline from [session-handoff](https://github.com/softaworks/agent-toolkit/tree/main/skills/session-handoff),
and brevity from [handoff](https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff).
No third-party skill is copied wholesale or installed.

```sh
node --test ~/.copilot/extensions/context-prune/*.test.mjs
```

Repository evaluations and their limits are documented in
[`evals/context-prune`](../../evals/context-prune/README.md).

# Context prune

User-wide Copilot CLI extension, invoked only by the user:

| Command | Effect |
| --- | --- |
| `/context-drop-tools [focus]` | Deterministically preserve non-tool text and readable thinking; replace tool calls/results with agent-written findings. |
| `/context-compact [focus]` | Apply a custom working-state summary using the lean `context-compaction` skill. |
| `/context-cancel` | Cancel an operation that has not applied. |

Both reduction commands apply immediately once the agent supplies the retained
state. They save the exact replacement as a checkpoint first, leave the original
session history intact, and reject queued input, background work, unresolved tool
requests, or changes that arrive while the replacement is being prepared.
The apply tool is always exposed and terminal: successful application ends the
tool phase, and the extension prints reload instructions directly.

Only `/context-compact` loads the compaction skill. Drop mode asks the agent for
tool findings only; code assembles the retained transcript. It preserves exact
message content, model-transformed user text, readable reasoning text, readable
reasoning-block text and completed reasoning events, message phase, and citations,
in their recorded order. Repeated drops do not summarize previous findings or
non-tool text. Exact generated operation prompts, seed copies, and reload
acknowledgments are excluded rather than accumulated as task history.
Transient streaming deltas are not duplicated over their finalized messages.

`clearContext` accepts a single replacement string, not native message edits:
retained messages/thinking become labeled historical text. Provider-private or
encrypted reasoning state cannot be restored as native reasoning blocks by this
API. Opaque ciphertext, native IDs, and signatures are not copied into the
replacement. Readable block text is kept verbatim, without duplicating an
identical `reasoningText`; it remains historical text, not a signed native replay.
Similar but nonidentical readable text is not fuzzy-deduplicated, since that could
remove meaningful differences. Tool findings are limited to 12000 characters each
to reject accidental log pastes; the agent chooses the summary length.
This is text preservation, not preservation of hidden model state or
original wire roles. Tool-only mode refuses attachments rather than silently
flattening them.

**Reload afterward:** run `/exit`, then `copilot --resume <same-session-id>`
using the exact ID printed by the apply tool. This resumes the existing session;
it does not create another conversation. This CLI version can resurrect stale
live messages after context clearing, so automatic refresh is deliberately not
assumed. Do not continue task work before reloading.

`context_history` searches this session's existing history with `query`, or
recovers original tool output with `callId`. Large results are paginated using
`offset`/`nextOffset`; subsequent pages must also include the first response's
`beforeEventId` to keep the snapshot stable. The retained context explicitly instructs the agent to use
this tool or `session_store_sql` when omitted information is needed.
If Copilot itself truncated a large result, history may contain only its preview
and a native temporary-file reference. The agent must recover that existing
artifact if available and permitted, or explicitly report the gap; this extension
does not create a second output archive or promise recovery of expired files.

The checkpoint is custom persistence, not a native compaction event or native
compaction counter entry. No journals are rewritten, no second transcript archive
is created, and no background compaction or monitoring is installed. Attachments
and binary tool results
cannot be faithfully flattened by tool-only mode; use custom compaction instead.
If checkpoint saving succeeds but application fails, the explicitly reported
prepared checkpoint remains; unrelated or native checkpoints are never deleted.
Summary fidelity depends on the agent: schema/coverage checks cannot prove that
every important fact was retained.

The original skill combines anchored working-state retention and observation
masking from [Agent Skills for Context Engineering](https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering),
the coverage discipline of [session-handoff](https://github.com/softaworks/agent-toolkit/tree/main/skills/session-handoff),
and the brevity of [handoff](https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff).
No third-party skill is installed or copied wholesale.

Run local tests with:

```sh
node --test ~/.copilot/extensions/context-prune/context.test.mjs
```

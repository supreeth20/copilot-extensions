# Independent context-prune evaluations

Fixtures are synthetic. Test code and instructions are versioned; generated JSON
results, local audit reports and disposable `.runs/` workspaces are not.

## Deterministic tests

From the repository root:

```sh
node --test extensions/context-prune/*.test.mjs evals/context-prune/independent.test.mjs
```

These cover narrative retention, readable reasoning, repeated/mixed reductions,
native-compaction boundaries, interrupted tools, checkpoint readback, cancellation,
single-use authorization, concurrency guards, hook correlation, progress events,
restart ordering and failure recovery, and attachment-reference integrity.

Journal-search assertions use `extensions/context-prune/test-support/history.mjs`;
that helper is not imported by production. Native history remains the user-facing
recovery mechanism.

## Live SDK checks

Requires an authenticated CLI and matching SDK. Set `COPILOT_EVAL_SDK` to that
SDK's `index.js`, then run:

```sh
COPILOT_EVAL_CLI="$(command -v copilot)" node evals/context-prune/live-sdk.mjs
```

The runner defaults to `gpt-6-astra`; `COPILOT_EVAL_MODEL` overrides it.
It dispatches real SDK slash commands with isolated tool-free generation workers.
Checks include repeated reductions, exact checkpoints, original journal survival,
unchanged non-tool narrative, recorded errors/status, cold resumes and cleanup.

Use `--attachments` for file-reference recovery, deleted image source recovery
from recorded bytes, native oversized-paste markers and permitted rereading of
changed text documents after drop, two compactions and cold resumes. Add `--hooks`
to exercise commit pre-tool hooks and transient progress delivery. SDK event
delivery alone does not verify visual TUI rendering.

Use `--idle-agents` for same-handle child follow-up after parent compaction and
cold resume. Add `--idle-agents-baseline` to omit reduction for comparison.
Cold-runtime agent-handle loss was observed both with and without compaction;
the runner reports that limitation separately rather than claiming restored
handles.

The runner creates an isolated home/config/workspace under ignored `.runs/`,
stops clients, deletes its owned parent/workers through the SDK and removes
owned run files. Never point it at an existing session. On forced termination,
verify the owned process has stopped before removing its specific run directory.
Do not publish local journals, identities, authentication data or run artifacts.

## Native attachment experiments

Run `attachment-restoration.mjs` with the same SDK/CLI environment variables.
The default loopback-only synthetic provider inspects outbound multimodal blocks
and image hashes; it replies ACK and is not an image-understanding model.
`--real-model` checks visual recognition with Astra. `--pdf` selects a PDF blob;
`--pdf-file` selects a path-backed PDF. Unsupported initial delivery is not a
restoration defect.

PNG experiments established that explicit asset-reference or original-byte
reattachment can work after cold resume. Bare clear/resume and composer push alone
did not restore model access. PDF baseline delivery was unsupported in the tested
configuration; PNG success is not generalized to PDFs. Production implements
file-reference recovery, not automatic native attachment replay.

## Coverage limits

The retained projection is labeled historical text, not native message roles or
provider-private reasoning. Provider-hosted tool payloads and subagent-only history
are not fully retained. Findings and summaries depend on model faithfulness;
schema validation does not prove semantic completeness. There is no input-budget
preflight, chunking or guaranteed positive token savings.

Native-history recovery cannot recreate expired spill files or bytes omitted by
upstream persistence. Referenced files can change or disappear and require
appropriate permitted reading tools. Universal document/media interpretation,
custom-provider reproduction and real concurrent-input/native-compaction races
remain unverified.

Prior isolated native TUI checks exercised production compaction, automatic native
restart, same-session resume, `/version` dispatch and restart autocomplete. The
reported command-recognition failure was not reproduced; its cause remains
unconfirmed. The SDK driver is not a substitute for native UI testing, and stored
historical counts are not fresh validation of later changes.

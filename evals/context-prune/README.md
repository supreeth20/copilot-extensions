# Independent context-prune evaluations

Fixtures are synthetic. GPT-6 Astra independently designed the original baseline
without earlier reports and without changing implementation files. Historical
results are retained separately below. Runtime-contract tests and the live driver
were subsequently migrated for the explicitly requested code-owned architecture;
pure retention/recovery oracles remain.

Journal-search assertions use `extensions/context-prune/test-support/history.mjs`;
that evaluation helper is not imported by the production runtime. Native history
remains the user-facing recovery mechanism.

From the repository root:

```sh
node --test evals/context-prune/independent.test.mjs
node --test extensions/context-prune/*.test.mjs
```

Live integration requires an authenticated CLI and its matching SDK. Set
`COPILOT_EVAL_SDK` to that SDK's `index.js`, then run:

```sh
COPILOT_EVAL_CLI="$(command -v copilot)" node evals/context-prune/live-sdk.mjs
```

Run the focused attachment scenario instead with `--attachments`. It sends a
synthetic code selection and image, records a binary diagnostic result, verifies
that drop preserves references and saves recoverable bytes, compacts through real
isolated workers, and cold-resumes the same session after each reduction.
It also includes an original text document and pasted text: the file is changed
after each reduction, and the real model must call the permitted fixture reader
and report the new contents and original pasted text from their retained paths.
Checks cover exact selection text/path/range, binary provenance,
absence of inline image bytes in generation input, retained requirements and
evidence references in the summary, checkpoints/history, and native session cleanup.
The scenario additionally sends a native-format oversized-paste marker and a
file-backed image with a recorded asset, deletes the image source before the
first reduction, and verifies the durable copy and text references through drop,
two compacts and cold resumes. The model rereads the native pasted text as well.
The reader is restricted to this run's synthetic text attachments; this is
not proof that arbitrary PDFs can be read without an appropriate document tool.

The live runner defaults to `gpt-6-astra`; `COPILOT_EVAL_MODEL` overrides it.
It invokes the repository's handlers through real SDK slash-command dispatch,
uses two harmless diagnostic calls, applies two drops and four consecutive
compactions, and cold-resumes the same disposable session after each reduction.
Only diagnostic and the
code-authorized transition adapter are permitted in the parent. Generation
workers have no tools. Fixture and adapter tools are registered at session
creation; neither the runtime nor the driver dynamically replaces tools.
It creates an isolated home/config/workspace under ignored `.runs/`, stops its
clients, explicitly deletes its parent session and generation workers through
the SDK, and removes that run's files. Never point it at an existing session.
No model reasoning, journals, identities, or local paths are printed.
On externally forced termination, remove only the abandoned child of `.runs/`
after verifying its owned process has stopped.

## Current code-owned results

| Suite | Pass | Fail |
| --- | ---: | ---: |
| Regression and migrated independent assertions combined | 153 | 0 |
| Real SDK attachment paths, deleted image source, drop/two compacts and cold resumes | 63 | 0 |
| Earlier actual TUI oversized paste and clipboard image, drop/compact and cold resumes | 20 | 0 |
| Hook-enabled SDK attachment recovery and progress-event assertions | 69 | 0 |

`hook-progress-results.json` records a subsequent `--attachments --hooks` run:
three code-owned commit pre-tool hooks ran, 12 transient progress messages were
observed, and drop/two compacts with cold resumes passed. This is SDK event
verification, not a new visual Orca assertion. Unit tests cover the exact native
pre-tool/permission hook journal shapes observed in the reported failing session,
including rejection of foreign hooks, failures and added hook context.

`native-command-results.json` records an actual Orca TUI check, not SDK dispatch
alone. The initial deterministic fixture retained the same runtime command
catalog after clearing, showed native restart autocomplete and all four progress
messages, and verified queued native restart. A subsequent command used the
unchanged production entrypoint and real SDK generation: `/context-compact`
automatically restarted the CLI, the journal recorded shutdown and same-session
resume, `/version` executed afterward, and restart autocomplete remained visible.
Native folder-trust and extension permission prompts reappeared. The user's
command/autocomplete failure was not reproduced, so its root cause is not claimed
fixed. Both reduction modes' restart ordering and explicit failure recovery are
covered by unit tests; only compact used the real generator in this TUI check.

`native-reference-results.json` records the latest hardening implementation;
`attachment-path-results.json` retains the earlier 44-check file-reference run.

`live-sdk.mjs --idle-agents` tests a real idle subagent, parent compaction,
same-handle follow-up with retained child context, and cold resume. Add
`--idle-agents-baseline` to omit reduction for comparison. Live post-clear reuse
works; in both tested cold-runtime cases the task handle disappeared and
`sendMessage` reported "Agent not found or not accepting messages". Reports keep
this host limitation in `metrics.idleAgentColdResume`, not as a passing assertion
of cold-resume reusability. Parent/worker sessions and run files are deleted.
Original document paths and saved pasted text survived both reduction modes and
cold resumes; the real model reread them through the fixture tool and returned
the updated file contents rather than stale content. Pasted image and binary-tool
bytes were also saved and checked byte-for-byte, without claiming new visual
interpretation coverage. All three generation workers and the parent were deleted.
Unit tests additionally cover missing evidence, invalid bytes, persistence failure,
private file permissions, corrupted cache detection, and repeated mixed reductions
whose summaries omit the references entirely.
Saved PDF/text references are replayed without journal payloads to verify that
corruption prevents generation and clearing, deletion is disclosed, and restored
original bytes recover availability. Ordinary document/image paths may change
without failing checks against original checksum or length metadata.

`native-paste-results.json` records the actual interactive input paths, not
SDK-created stand-ins: bracketed paste of 133977 bytes/2502 lines and native
Ctrl+V of a macOS clipboard PNG. The large paste became a session-owned
`files/paste-*.txt` file referenced by a `<pasted_content file="...">` marker in
`user.message.content`, with no attachment object. The clipboard image became a
`file` attachment pointing into the OS temporary directory, plus a persisted
binary-asset reference. Both files survived ordinary CLI exit, and the real model
used native `view` to reread them after drop and compact with cold resumes.
Text verification checked both end markers; image verification checked the
actual bytes of the opened file and real quadrant recognition, accepting either
the original path or a byte-identical saved copy.

That historical TUI sequence exposed two gaps, now addressed in code: native
large-paste markers become code-owned references, and recorded image bytes are
saved proactively instead of retaining only a temporary path. The original
20-check report remains unchanged evidence of the earlier implementation, not a
new TUI run or a temporary-file-deletion test. New runtime tests intentionally
omit all paths from summaries and repeat mixed reductions; the extended SDK
scenario deletes its file-backed image before the first reduction and verifies
recovery from the recorded asset. Neither test claims automatic native replay.

The native TUI harness stayed in session-local artifacts. Its initial calibration
handled the extension's permission prompt, included `context_commit` in the
restricted tool allowlist, waited for final replies rather than intermediate
tool-round ends, and allowed valid saved-copy reads instead of requiring only the
original pathname. Earlier harness failures were not counted as product defects.
The original clipboard was restored, owned sessions were deleted through native
SDK APIs, and the owned test directories were removed.

Before file-reference recovery was added, both SDK scenarios passed: 121 repeated-reduction
checks and 29 attachment checks, alongside all 112 regressions. An
independent code reviewer reported no significant issues. Production code shrank
from 752 to 640 lines by removing the unused manifest builder and stage state,
moving historical search into test support, and eliminating an extra event scan.
Checkpoint verification, cancellation, authorization and legacy replay remain.
The interactive CLI result below is historical, not a new TUI run.
Those 121/29 checks and the 16-check interactive result were not rerun for the
latest file-reference change.

The live driver checks exact checkpoints, original journal survival, unchanged
non-tool narrative, repeated findings, cold resume, recorded errors/status,
required compact headings, no parent model turn, zero worker tool execution,
and deletion of all six generation workers and the disposable parent. Consecutive
compactions check one prior summary without transcript nesting or raw tool
messages, evolving failures and next steps, stable exact identifiers/commands,
deployment/network prohibitions, a newly introduced approval boundary, and
continued unverified status. A separate twelve-round deterministic replay test
checks replacement boundaries and unchanged original history.
The upstream exception-marker
behavior is reported as a metric, not incorrectly treated as lost data that the
extension could recover.

`consecutive-compaction-results.json` records the expanded live validation.
`attachment-results.json` records the focused attachment run, including one
recorded attachment asset reference and exact original attachment-event
preservation after resume. Its parent session and generation worker were deleted;
no test sessions remained in the local history index.
`command-owned-results.json` preserves the earlier 108-test/38-check baseline and
the separate 16-check interactive run. The SDK driver
passes an explicit CLI executable, unlike the installed entrypoint's resolver.
The separate interactive CLI run loaded the actual extension, exercised its
production resolver, verified exact drop retention/checkpoints and original
history, cold-resumed the same session, then applied the six-section compaction.
It exposed the restriction on dynamically replacing tools from an extension;
the final implementation registers an inert adapter at join and leases only its
authorization, never model-controlled application authority.

The first full consecutive-compaction calibration report is retained in
`consecutive-compaction-initial-results.json`; its five failed probes do not
establish five product defects. Referencing a concise tool finding is not
resurrecting a raw tool message, and explicitly saying the current step replaces
the previous step is not retaining a stale next action. The corrected probes
inspect message roles and the current `Next` section; previous-step references
remain visible in metrics and were manually checked. A later calibration also
removed an arbitrary short distance limit from negated action-list matching.
Persistent checkpoint workspaces require infinite sessions in the parent;
generation workers remain isolated with infinite sessions disabled.

The independently confirmed attachment-input omission is fixed: compact now
receives recorded attachment text/metadata and binary-result descriptions,
asset references and resource URIs. Binary payloads are excluded with an explicit
uninspected-content notice, and the skill requires retaining relevant attachment
requirements, recovery references and evidence gaps. This does not restore native
attachments or establish visual-content interpretation or universal summary
fidelity.

## Native attachment restoration experiments

The earlier attachment suite tested metadata/selection preservation, references
in summaries and original event survival. It did **not** establish that the model
could see original native attachment content after replacement.

Run `attachment-restoration.mjs` with the same SDK/CLI environment variables.
By default it uses the real CLI/SDK with a loopback-only synthetic OpenAI-compatible
provider to inspect actual outbound multimodal blocks and compare image hashes;
the local provider replies ACK and is not an image-understanding model.
`--real-model` instead cross-checks actual visual recognition with Astra.
`--pdf` selects a PDF blob; `--pdf-file` selects a path-backed PDF. Those are
distinct routes, and an unsupported initial baseline is not a restoration defect.
The driver prints only synthetic observations and binary hashes, never raw model
requests, authentication headers, native reasoning or session IDs.

`attachment-restoration-wire-results.json` records 17 passing PNG/selection checks.
`attachment-restoration-model-results.json` records 15 passing real-model checks.
Both demonstrate that bare clear/resume does not restore the image, while
explicit asset-reference and journal-byte reattachment work and survive another
cold resume. The real model correctly identified all four large-image quadrants
after restoration, and returned NONE with no native image.
An initial 64-pixel visual fixture was unreliable even before clearing; its
failed recognition was not reclassified as a preservation success. A 512-pixel
fixture supplied the successful behavioral control.

An actual disposable extension also recovered original bytes and pushed them to
the host without starting a model turn. Push alone did not restore model access;
the host had to include the pushed bundle in its next send. Push events were not
persisted or automatically reemitted on restart; explicit recovery/repush worked.
This is an SDK integration experiment, not a completed production/TUI feature.

PDF probes did not pass native delivery: the PDF blob produced no native document
block even before clearing, although its inline bytes survived in the journal.
The path-backed PDF also returned NONE with the real model and tools disabled;
its original bytes were not in the journal. These are unsupported baselines, not
four newly demonstrated context-clearing defects. Different native-document
providers or document-reading tools remain unverified. The portable observations
and unsuccessful check counts are retained in
`attachment-restoration-pdf-results.json`; PNG success is not generalized to PDFs.

`preservation-gaps.json` distinguishes confirmed implementation limitations from
untested cases, including omitted provider-hosted tool payloads, subagent-only
history, unchecked replacement growth, lack of generator input budgeting, and
best-effort native-history/artifact recovery.

## Historical results after retention fixes

| Suite | Pass | Fail |
| --- | ---: | ---: |
| Original independent deterministic/mocked assertions, unchanged | 28 | 0 |
| Regression suite, including five new cases | 59 | 0 |
| SDK integration, including three additional provenance/retention checks | 24 | 1 |

All confirmed extension defects below are fixed. Operation prompts now carry
origin metadata correlated with their operation ID, readable block multiplicity
survives mirrored metadata, and recovery indexes every distinct readable field
and returns recorded tool status/errors. Legacy string-result diagnostics and
unknown nested provider JSON are also handled. Finding serialization now remains
stable across replay, so both original byte-idempotence probes also pass.

The prior live runner's diagnostic-marker assertion failed: the SDK never
recorded the thrown marker. Its separate assertion verified
that recovery preserves the error the SDK actually recorded. This is explicitly
an upstream limitation, not a passing integration run or a remaining extension
defect. That historical runner therefore exited nonzero.

`post-fix-results.json` records this validation separately from the baseline.
At that stage the independent test file and original assertions were unedited.

## Original baseline results

Node 26.4.0, CLI/SDK 1.0.103:

| Suite | Pass | Fail |
| --- | ---: | ---: |
| Independent deterministic/mocked | 19 | 9 |
| Existing regression suite | 54 | 0 |
| Final isolated SDK integration checks | 18 | 4 |

These counts are **not defect counts**.
`results.json` records portable source fingerprints, repro selectors, ranked
findings, and distinctions between defects, risks, and unsupported assumptions.

Highest-priority findings:

1. A literal user message starting `[context-prune operation]\n` is silently
   excluded from both drop and recovery search. Reproduced on actual SDK events.
2. Recovery search omits block-only readable reasoning and distinct
   `transformedContent`; the journal exists but these fields cannot be found.
3. Readable-block deduplication removes repeated blocks within one representation.
4. Recovery does not expose the recorded tool `success` flag. This is a weak
   recovery contract, not evidence of lost original journal events.

The two byte-idempotence failures are **overly strong oracles**, not product
defects: JSON object keys change order, but semantic retention passes a separate
four-fixture, twelve-round test. The legacy string-result/error failure uses a
shape outside the current SDK schema. The null reasoning-part crash is a
robustness risk, not a demonstrated provider output.

One live failure expected an exception marker that the SDK itself did not
record. The diagnostic handler definitely executed and threw; recovery preserved
the SDK's recorded error exactly. This is an upstream recovery limitation, not an
extension defect. The remaining live failures cover prefix exclusion twice and
missing structured success status.

## Coverage and limits

Covered: exact prose/Unicode/whitespace fields; delimiters; repeated/mixed replay;
native-compaction boundaries; interruption and late completion; stable pagination;
invalid history inputs; checkpoint ordering/readback/retry; authorization; busy
states; concurrent apply/cancel; staleness while saving; ambiguous clear failure;
attachment refusal; mode separation; real slash commands and cold resume.

Not covered by the live SDK driver: native compaction races, actual
reasoning-block providers, TUI discovery/stale-message behavior, real binary
artifacts, expired spill files, or comprehensive model-written summary quality.
Mixed compact/drop and native boundaries
are synthetic tests. Live narrative stability compares the projection before
and after; the separate literal-prefix oracle checks fidelity to the raw event.
Two live message-count readings were both 2; that does not overturn the documented
TUI reload requirement or prove token savings.

Historical live-driver calibration corrected an RPC parameter name and a too-narrow
failed-event selector, then explicitly allowed only the three diagnostic/context
tools. Final counts above are from the corrected runner. No product assertion
was weakened; stronger-than-contract probes are explicitly classified instead.

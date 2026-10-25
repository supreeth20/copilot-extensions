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
that drop refuses them, compacts through a real isolated worker, and cold-resumes
the same session. Checks cover exact selection text/path/range, binary provenance,
absence of inline image bytes in generation input, retained requirements and
evidence references in the summary, checkpoints/history, and native session cleanup.

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
| Regression and migrated independent assertions combined | 112 | 0 |
| Real SDK command-owned integration, including consecutive compactions | 121 | 0 |
| Focused real SDK attachment compaction and cold resume | 29 | 0 |
| Actual interactive CLI drop, cold resume and compact | 16 | 0 |

After simplification, both SDK scenarios were rerun: 121 repeated-reduction
checks and 29 attachment checks passed, alongside all 112 regressions. An
independent code reviewer reported no significant issues. Production code shrank
from 752 to 640 lines by removing the unused manifest builder and stage state,
moving historical search into test support, and eliminating an extra event scan.
Checkpoint verification, cancellation, authorization and legacy replay remain.
The interactive CLI result below is historical, not a new TUI run.

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

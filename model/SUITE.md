# Whole-suite replacement audit

Baseline: `8b35282cd42995830fa59ecd3810b86c0640dc5c`. This audit covers every
tracked `*.test.ts` file, including the app, not just outbox tests. All test
titles were inventoried; proposed removals were checked against their actual
assertions and implementation. This is a behavior audit, not a mutation-coverage
proof of every retained assertion.

## Result

| Measure                                   |                Before |       After |
| ----------------------------------------- | --------------------: | ----------: |
| Spec files                                |                    49 |          49 |
| Test declarations                         |                   773 |         758 |
| Lines in spec files                       |                38,203 |      37,903 |
| TLA models                                |                     1 |           5 |
| Checked invariants, including type bounds |                     6 |          31 |
| Reproducible negative controls            | 2 previously recorded | 12 scripted |

These are source declarations, not Bun's expanded runtime case count:
`test.each` and loops can register several cases. Fifteen declarations are
removed; three retained declarations are narrowed/renamed as correspondence
checks. No complete spec file is deleted. The earlier outbox change's three
removals are already absent from the baseline and are not counted again.

The reductions are deliberately concentrated in ordering/state enumeration.
Removing most of this suite is **not justified by these models**: most remaining
volume executes SQL, serialization, parsers, API/SDK adapters, native processes
or the renderer. A model that assumes those operations work cannot replace
their evidence. There was no percentage target. The models add exhaustive
bounded interleavings rather than disguising test deletions as broader proof.

Exact per-removal replacements and concrete evidence are in [UI.md](UI.md) and
[BACKEND.md](BACKEND.md). [README.md](README.md) retains the separate outbox
mapping and assumptions.

## Every spec's disposition

Names below are relative to `test/`, except rows prefixed `app/`.

| Spec                    | Before → after | Behavior and retained concerns                                                                                                                                                                        |
| ----------------------- | -------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`                   |        59 → 59 | Cache deadlines, paging, auth, strict bodies, cursor signatures, attachments, reactions, mutation ordering and shared-client wiring. Models cannot check these adapters.                              |
| `app-contract`          |          5 → 5 | Actual daemon/main request and response decoder agreement, including malformed responses.                                                                                                             |
| `archive`               |        11 → 11 | Atomic cursor/storage, provenance, unfinished-reply paging, backpressure, rebinding and BM25. Its apparent retry cases also check real cursor/row representation.                                     |
| `avatar`                |          8 → 8 | Image bytes, decode, filesystem races, permissions and authenticated HTTP; not the Avatar view-state model.                                                                                           |
| `backup`                |        20 → 20 | Real locks/process death, WAL, fsync, backup/restore failure phases and integrity. Assuming durable storage in TLA is not storage evidence.                                                           |
| `daemon`                |        17 → 17 | Producer routing, schedule claims, time zones, filesystem workers and retained outbox correspondence.                                                                                                 |
| `db`                    |        23 → 23 | Each actual migration's columns, rows, triggers, defaults and reopen compatibility.                                                                                                                   |
| `doctor`                |        26 → 26 | Read-only diagnostics, byte preservation, schema compatibility, deadlines, redaction and machine-readable reports.                                                                                    |
| `dots`                  |          6 → 6 | Actual saved-session ID creation/reconciliation, filesystem identity and secret rejection. A session-create model would still need these small boundary checks.                                       |
| `feed`                  |          8 → 8 | Connector read/dismiss adapters and DB handoff; separate from FeedState's in-memory poll protocol.                                                                                                    |
| `fresh`                 |          4 → 4 | Actual session replacement, handoff composition, preserved memory and creation failure.                                                                                                               |
| `grants`                |          7 → 7 | Permission policy parsing, exact repository/branch/target scope and CLI owner consent.                                                                                                                |
| `image-delivery`        |          1 → 1 | Real public HTTP client plus SQLite reopen; essential outbox implementation correspondence.                                                                                                           |
| `instructions`          |          8 → 8 | Revision races plus actual atomic files, history/revert, UTF-8 caps and redaction.                                                                                                                    |
| `library`               |        16 → 16 | Filesystem containment, inode/link races, byte integrity, caps, private publication and authenticated downloads.                                                                                      |
| `measure`               |          6 → 6 | Fixture integrity, actual prompt composition, imported metrics and no-live-run guard.                                                                                                                 |
| `media`                 |        11 → 11 | SSRF/DNS/peer checks, media bytes, response limits and private filesystem cache.                                                                                                                      |
| `memory`                |        10 → 10 | Versioned SQL/API writes, legacy triggers, stale scheduler claims, field validation and redaction.                                                                                                    |
| `note-search`           |          9 → 9 | Unicode/index equivalence, SQL triggers, ranking, snippets, provenance and read scope.                                                                                                                |
| `observer`              |        41 → 36 | Lifecycle enumeration moved to Observer; retain real awaited guards, IDs, accounting, budget/day limits, chunk arithmetic, concurrency, rollback, parsing and privacy.                                |
| `opencode-wire`         |          4 → 4 | Installed public SDK over fake HTTP, including streaming and message parts.                                                                                                                           |
| `owner-answers`         |        12 → 12 | Request lifecycle candidates also assert card decoders/statuses, attempt ledger, owner consent, conditional forms and late actual reads.                                                              |
| `owner`                 |          8 → 8 | Versioned owner facts, aliases/tombstones, real transactions, UTF-8 budget and canonical rendering.                                                                                                   |
| `plugin`                |        64 → 64 | Actual hooks/tools, authority, instruction-entry bytes, schema stability, memory composition and invalidation. Switch enumerations test byte/schema identity, not just states.                        |
| `recall-route`          |          3 → 3 | Recall API paging, parameters, redaction and archive availability.                                                                                                                                    |
| `request-loops`         |          5 → 5 | Actual Effect fibers, separate loops and stalled dependencies; no fairness/liveness model claim.                                                                                                      |
| `request-timeouts`      |          1 → 1 | Three expanded phases exercise exact TestClock boundaries.                                                                                                                                            |
| `requests`              |        27 → 27 | Audited for a request state model. Retained because seemingly duplicate outcomes include distinct source visibility, ownership, policy, wording, attempt identity and API behavior.                   |
| `runs`                  |        11 → 11 | Turn attribution from actual history, provisional workers, redaction, SQL claims and run API.                                                                                                         |
| `schedule`              |          6 → 6 | DST, wall-clock/real-time arithmetic and normalization.                                                                                                                                               |
| `slack-agents`          |        44 → 44 | Stream/reply retry candidates retain actual marker lookup, saved text length, Slack payloads, coalescing and separate posting implementation.                                                         |
| `slack-setup`           |        33 → 33 | Login/config rotation, Keychain adapter, scopes, strict shapes, multipart icon and owner-reviewed install/update. These are authority and external API boundaries.                                    |
| `slack`                 |        22 → 22 | Shared-app identity/routes, history cursors, Retry-After and reply lookup; distinct implementation from per-dot Slack.                                                                                |
| `steer`                 |          8 → 8 | Actual delivery mode, stable IDs and public wire behavior; protected active Stop/queued-message work.                                                                                                 |
| `supervise-adversarial` |        15 → 12 | Deduplication enumerations moved to Supervision. Keep real rollback/reopen, awaited revoke, transport errors and paged public adapter.                                                                |
| `supervise-reverify`    |          4 → 3 | Redundant cursor scenario removed; all three public adapter regressions remain.                                                                                                                       |
| `supervise`             |          9 → 9 | Retained concrete cursor/reopen/text check now includes a tied ID; busy arithmetic, approval and deletion boundaries remain.                                                                          |
| `triggers`              |        10 → 10 | Revision-reviewed enablement, source baselining, burst bounds, transactional enqueue rollback and revoke wiring.                                                                                      |
| `tui`                   |        10 → 10 | Actual projection, sort/tie rules, overflow and 24-hour boundary; pure policy/data transformation rather than protocol interleavings.                                                                 |
| `usage`                 |          9 → 9 | Actual public-history walk, incomplete steps, cursor recovery, system-item classification and API representation.                                                                                     |
| `work`                  |        10 → 10 | Actual turn grouping, redaction, byte/count bounds and continuation cursors; protected execution-info work.                                                                                           |
| `workers`               |        26 → 26 | Stop/permit candidates reviewed but retained: gate/interrupt await, held admission, authorization and terminal behavior. Separate from one-ID Outbox model; active Stop work also owns this contract. |
| `app/chat`              |        30 → 30 | Captured drafts, exact references, image/URL validation, history windows, reaction fencing and presentation. Protected composer/info work.                                                            |
| `app/clipboard`         |          4 → 4 | Real stream chunking, callback cleanup, timeout and zeroing token bytes.                                                                                                                              |
| `app/markdown`          |        12 → 12 | Actual parser/render output, sanitization, code/diffs/math and copy bytes.                                                                                                                            |
| `app/ported`            |        15 → 12 | Avatar revision enumeration moved to Avatar; one real class check and all labels, schedules, audit/link checks remain.                                                                                |
| `app/service`           |          7 → 7 | Fake executable and login shell, exact argv, concurrency, exit/stderr and timeout behavior. Never uses live service controls.                                                                         |
| `app/smoke`             |        44 → 44 | Real hidden Electron/main/bridge/renderer: state wiring, interaction, layout, selection, drafts and accessibility. No DOM or native evidence is replaced by a model.                                  |
| `app/surfaces`          |        24 → 21 | Feed poll enumeration moved to Feed; real class correspondence and 1,000-item overflow remain. Drafts, instruction conflicts, forms and search wiring are unchanged.                                  |

## Other model candidates considered

- **Request answers:** a useful future model would include two attempt IDs,
  current-attempt fencing, the session gate and in-flight recovery. It cannot
  replace owner versus dot versus Threads card behavior, exact timeout phases
  or permission policy. After retaining those and one implementation check per
  real await, the current small repeated cases did not justify another model
  here. They were not silently treated as covered by Outbox.
- **Worker stop/permits and route FIFO:** outside Outbox's current bounds, and
  distinct from its authorization bit. Their tests stay rather than assuming
  an existing one-ID admission model proves stopping/resuming or A/B/A routing.
- **Slack stream lifecycle:** would need start/append/stop/final-update phases,
  rate-limit assumptions and separate shared/per-dot correspondence. The
  current tests inspect real payloads, markers and persistence at those phases.
- **Observer budget/chunk concurrency:** not folded into a large all-purpose
  model. The lifecycle model does not establish SQL counting, exact token/day
  arithmetic or partitioning long source messages; those focused tests stay.

No production code, dependencies, migrations, runtime configuration or live
services change. Protected Stop commit `e10a515` was compared by changed paths;
none of its API/steer/fake/contract/Electron test files is edited here. All counts
above describe this isolated baseline, not concurrent workers' later additions.

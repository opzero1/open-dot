# Protocol models

Run `bun run model:check` for every checked-in TLA model and
`bun run model:negative` for the twelve required failing controls. The latter
writes only ignored `.research/model-negative/` copies and logs. These commands
invoke the pinned real checker; neither executes a hand-written state simulator.

See [SUITE.md](SUITE.md) for the whole-suite before/after audit, [UI.md](UI.md)
for Feed and Avatar, and [BACKEND.md](BACKEND.md) for Supervision and Observer.
The original Outbox contract and its separate first-pass audit follow below.

## Outbox admission model

Run from the repository root:

```sh
bun install --frozen-lockfile
bun run model:check
bun test test/daemon.test.ts test/image-delivery.test.ts test/supervise.test.ts test/supervise-adversarial.test.ts test/workers.test.ts
```

This uses the supported `tla-ts` CLI, pinned to 0.0.8 in `bun.lock`, not a
TypeScript simulation or a replacement for runtime tests. The CLI reads
`Outbox.cfg` beside `Outbox.tla`, explores the finite state graph, prints counts
and a counterexample on failure, and exits nonzero for a violated invariant.
Upstream documentation and CLI source were inspected at
[`8067c48`](https://github.com/aidenybai/tla-ts/tree/8067c48004dbda038547adf1a125c835a32d16be).

## Contract and bounds

The protocol is `deliver` / `admit` in `src/daemon.ts`: persist intent, acquire the
session gate, read the current row, look up its saved ID, recheck permission,
then prompt only if absent. A lost response stays pending. This is an important
boundary because a duplicate prompt can start a second agent action.

The model starts with **one already-persisted pending message ID in one fixed
session**, two competing callers, at most two prompt calls, and one permanent
authorization revocation. Repeated lookups, failures and restarts are unbounded
cycles in the finite graph. `started` abstracts `started_at`; `admitted` is the
upstream fact, not the daemon's knowledge. `calls` counts attempts, including
refusals; `admissions` counts accepted calls, without silently deduplicating them
in the model. `unsafe` remembers a call made after authorization was revoked.

Checked invariants:

- `TypeOK`: every field stays in its bounded domain.
- `PersistBeforeCall`: any prompt has a durable start marker (the ID already
  exists by the initial-state assumption).
- `NoDuplicateAdmission`: at most one call is accepted for this saved ID.
- `NoUnauthorizedCall`: no new call starts after revocation. A call already in
  flight may still be accepted after revocation.
- `SentMeansAdmitted`: a sent row corresponds to an upstream admission.
- `CancelledMeansAbsent`: a cancelled row was not admitted upstream.

No fairness or liveness claim is made. `UNCHANGED vars` allows quiescence,
unavailability and the call bound to stop progress; this is not a deadlock test.

## Mapping to implementation and retained runtime evidence

| Model transition             | Implementation                                                                                                                      | Runtime evidence (test title fragment)                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial saved row            | `enqueue`, producer transaction; ID is reused by `admit`                                                                            | `image-delivery`: “images survive SQLite reopen and public HTTP delivery…” asserts the saved ID and `startedAt` inside the public prompt handler                |
| `Begin`, `CancelUnstarted`   | `deliver` acquires `gated(sessionID)` and rereads state; `admit` cancels an unauthorized unstarted row, otherwise saves `startedAt` | `workers`: “a delivery that read its message before a stop waits for it, then sends nothing”; `supervise`: “a revoked binding's unsent message…”                |
| `Lookup`, `LookupFailed`     | `messageExists(ref)`; failure exits without a prompt or sent update                                                                 | `daemon`: “a schedule retries an absent admission with its saved ID, but not during a failed lookup”; `image-delivery` tests the public adapter's failed lookup |
| `Revoke`, `Cancel`, `Prompt` | `canSend` is read again after the lookup await, before `opencode.prompt`                                                            | `supervise-adversarial`: “issue27: revoke while message existence request is awaited cancels before prompt” holds that actual await                             |
| `Resolve`, `Confirm`         | prompt succeeds, fails before admission, or loses its response; only successful prompt/positive lookup marks sent                   | `daemon`: “lost admission survives reopening and holds a competing thread…” and “a schedule retries an absent admission…”                                       |
| `Crash`                      | lose local execution and semaphore, keep SQLite row and upstream state, reconcile by saved ID on a later pass                       | `image-delivery` reopens SQLite after a lost response; `supervise-adversarial`: “lost send admission plus revoke and unavailable lookup remains conservative”   |

`Crash` nondeterministically accepts an outstanding call or leaves it absent
before a subsequent lookup. It also covers a crash after acknowledgment but
before saving `sent`. Runtime tests establish selected correspondence points,
not a mechanically proved refinement from TypeScript to TLA+.
They reopen SQLite in the same process, not at real process-kill failpoints;
neither the acknowledgment-before-sent crash nor two simultaneous deliveries of
the same ID is directly injected by these tests.

The initial checked model explored 280 generated / 68 distinct states, depth 13,
with no states left queued. Two temporary negative controls, using the same
configuration, exited 12 with counterexamples: removing `Prompt`'s `allowed`
guard violated `NoUnauthorizedCall`; making `Lookup` always return absent
violated `NoDuplicateAdmission` after two accepted calls with lost responses.

## Assumptions and limitations

- One daemon process owns admission. The semaphore is in-process, not a
  distributed lock. Two concurrently running daemons are outside this model.
- SQLite writes are atomic and durable. Row creation, transaction rollback and
  unique IDs remain runtime-test responsibilities.
- A successful by-ID lookup is authoritative across inbox and history. An
  absent response does not race an older unresolved upstream admission. The
  admitted ID remains visible; upstream deletion or forgetting is excluded. The
  model does not prove this network/API assumption; OpenCode's stable-ID
  deduplication is additional protection, not implemented by this model.
- Authorization checking and call initiation have no intervening modeled await.
  A crash kills old local execution; it does not leave a second daemon fiber
  running. Upstream calls may settle as described above.
- Payloads, routes/FIFO, turn completion, steering, held messages, stop/resume
  permits, rebinding, scheduling, timeouts and multiple message IDs are excluded.
  Their runtime regression tests remain. A model pass proves neither those
  features nor the production TypeScript implementation.

## Earlier outbox-only audit

The audit inventoried the existing test titles and searched source-reading
assertions, then compared delivery and supervision candidates with their actual
assertions and implementation paths. It was not an exhaustive mutation-coverage
audit. No deletion quota was used. Three redundant cases were removed:

| Removed test                                                                                          | Why no distinct failure coverage is lost                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/daemon.test.ts`: “a delivery whose response was lost is confirmed by ID, not sent again”        | The same `admit` path and pending-to-sent assertion remain in the schedule restart test, the competing-thread restart test, and the public HTTP image-delivery test. The latter also checks persistence before the call and lookup failure. Reminder production is still tested separately. |
| `test/daemon.test.ts`: “a delivery OpenCode never admitted is sent again with the same message ID”    | “a schedule retries an absent admission with its saved ID, but not during a failed lookup” covers the same failure/retry path and stable ID, plus the no-retry-on-failed-lookup branch. The producer does not alter admission behavior.                                                     |
| `test/supervise.test.ts`: “a binding revoked while the daemon looks the message up is never admitted” | Its Proxy over the fake Set revoked synchronously inside a lookup. The retained adversarial test suspends the actual lookup await, revokes, then resumes it. Its assertion now also retains the removed case's durable `startedAt` check.                                                   |

The model did not justify any deletion. Public adapter, rollback, migration,
security, timing, stop/resume and different producer tests retain distinct
coverage. No app/UI regression test was removed or changed. Even small boundary
tests, such as exactly ten sidebar workers versus overflow, were retained rather
than treating size or simple expected values as evidence of low signal.

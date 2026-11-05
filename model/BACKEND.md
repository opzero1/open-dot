# Backend protocol replacements

These models check transition ordering, not database or SDK correctness. All use
pinned `tla-ts` 0.0.8, finite exhaustive state exploration and stuttering. There
is no fairness, liveness, distributed-daemon or TypeScript refinement proof.

## Supervision cursor

`Supervision.tla` models `watchOne` in `src/daemon.ts`. The initial binding is
active at timestamp zero. Four turn IDs have timestamps 0, 1, 1 and 2, and two
request IDs may appear, disappear and reappear. `Read` captures arbitrary
subsets; `Commit` rechecks the binding and uses the durable cursor rather than
the value from before the read. `Revoke` may happen across that await. `Abort`
loses only the local read, as a failed lookup or restart does. Atomic commit is
an assumption, tested separately with a real SQLite rollback trigger.

`Fresh` maps to the time/ID predicate at `watchOne`'s `ends.filter`: a timestamp
equal to activation is excluded, but a new ID tied with an already observed end
is included. `Newest` and `seenIDs` map to the rolling timestamp boundary.
`told` maps to the permanently retained `waitingOn` keys. Sets abstract the
implementation's Map deduplication of repeated IDs within one response.

Invariants check types, at-most-once turn and request notices, exclusion of the
activation boundary, no commit after revocation, and no eligible end lost from
the committed snapshot. The last invariant covers timestamps at or beyond the
current cursor, not an older event first discovered after that cursor moved.
That ordering assumption is explicit: the implementation ignores such older
late arrivals too. One outstanding read is modeled; competing database
transactions, JSON encoding, wall-clock busy intervals, deleted sessions and
notice text are not.

Negative controls remove timestamp-tie handling (must violate
`NoEligibleEndMissed`) and forget old waiting IDs when a snapshot omits them
(must violate `NoDuplicateWaiting`).

| Removed declaration                                                                                                | Replacement and retained concrete evidence                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supervise-adversarial`: “issue27: equal-time terminal IDs discovered on separate polls survive restart”           | `NoDuplicateTurn` and `NoEligibleEndMissed`; `supervise`'s “each event is reported once…” now checks a new tied ID after an actual SQLite reopen, alongside existing text and routing assertions.                                                                                        |
| `supervise-adversarial`: “issue27: equal-time terminal IDs in one poll are distinct and are not replayed”          | All same-time subsets in `Read`/`Commit`; the same retained implementation test plus the public adapter's timestamp-ties-across-pages test.                                                                                                                                              |
| `supervise-adversarial`: “issue27: a waiting ID is never reported twice after absent poll and restart”             | `NoDuplicateWaiting` across arbitrary empty/nonempty snapshots; retained reopen test and “concurrent waiting IDs and busy once-per-interval persist across reopen” exercise durable request keys.                                                                                        |
| `supervise-reverify`: “issue27 reverify: activation boundary, rolling seen IDs and dedupe transaction are durable” | Activation, ties and rolling cursor are modeled; retained `supervise` reopen check exercises the cursor, and “issue27: event cursor and notice insert roll back together” retains actual transaction failure. The removed test's second rollback setup was redundant, not proved by TLA. |

All public-adapter, real awaited-revocation, auth, CLI, escaping, deletion and
busy-spell tests remain. The existing outbox admission evidence remains intact.

## Observer lifecycle

`Observer.tla` models one job's saved identity and asynchronous lifecycle in
`src/observer.ts`. There is one job, one saved prompt ID and at most two prompt
calls, so accidental replay can be found rather than excluded by a one-call
bound. `valid` starts true and may become permanently false at any await. It
abstracts the conjunction in `wanted`: state, generation/model/settings, exact
ready binding and ledger epoch. This does not prove those predicates are wired
correctly; concrete tests still exercise settings, binding and epoch changes.

| Model action                            | Implementation correspondence                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Claim`                                 | `start` saves started state, scratch/prompt IDs and claim before creating the scratch session. Preliminary compaction and budget eligibility are assumed satisfied.                    |
| `Created`                               | Collapses scratch creation and its authoritative lookup into confirmed/absent/unknown; a known pre-prompt cancellation releases the claim.                                             |
| `Prompt` / `PromptResult`               | Saves charge before the call; a successful response is admitted, while a failure can still have admitted upstream.                                                                     |
| `Lookup` / `LookedUp`                   | Failed prompt reconciles by saved ID only while wanted. Confirmed absence may release an unspent claim; uncertainty does not.                                                          |
| `Crash`                                 | Discards execution but retains started row, IDs and charge; an outstanding prompt may have been admitted.                                                                              |
| Recovery lookup                         | `observePass` recovers started jobs by ID: present runs, absent or unknown never resends. The model collapses a present-but-invalid recovery's running state followed by cancellation. |
| `Turn`, `Usage`, `UsageResult`, `Apply` | `poll` checks validity before each read and before applying. A usage response already received is recorded even if the job became unwanted while awaiting it.                          |
| `Cancel` / `Invalidate`                 | A queued/running unwanted job ends; an unconfirmed started prompt becomes unknown, not eligible for replay.                                                                            |

Invariants check type bounds, durable ID and charge before a prompt, no second
prompt, release only when unadmitted, no new unwanted read or application,
recording known usage, and admission before application. Negative controls
remove the post-turn validity guard, make unknown jobs start again, and discard
known costs on invalidation. These must violate `NoUnwantedRead`,
`NoPromptReplay` and `KnownCostRecorded` respectively.

The by-ID lookup must be authoritative; an old upstream call may not become
admitted after an absence was returned. Creation/lookup outcomes are collapsed,
not a model of SDK decoding or every error class. A failed recovery lookup is
collapsed to eventual unknown; its real 30-minute timing remains tested.
No claim is made about chunk splitting, multi-job scheduling, daily arithmetic,
retry counts for a new job, operation parsing, source validity, forgetting,
checkpoint ordering or token accounting totals. Their tests all remain.

| Removed or narrowed declaration                                                 | Replacement and retained concrete evidence                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “lost outcomes are looked up by ID and never sent again” (narrowed)             | The scenario matrix is replaced by lifecycle exploration. “observer admission and restart reconcile the saved prompt ID without replay” retains actual accepted-lost-response lookup, saved ID, restart reconciliation and no replay. Failed admission/release also remains in chunk/retry tests. |
| “a job a stopped daemon left started is unknown unless OpenCode has its prompt” | Recovery transitions plus that focused concrete test's present/absent started rows. This is saved-row recovery, not a real process-kill test.                                                                                                                                                     |
| “a running job's answer is never read once the observer is off”                 | `Invalidate`/`Cancel`, with the retained actual off-during-turn test and owner-forget test. The removed case only assigned a running row directly.                                                                                                                                                |
| “a settings change during the turn read means no usage call”                    | `NoUnwantedRead`; “a poll reads nothing more, and records no reported use, once its job is unwanted” retains the same real callback boundary. Model-change and disable/re-enable generation predicates remain in their separate concrete test.                                                    |
| “a rebind before the poll reads nothing at all”                                 | Validity before `Turn`; retained owner-forget epoch check and failed-prompt-during-rebinding check establish concrete cancellation and binding correspondence.                                                                                                                                    |
| “a started job left behind is unknown without a lookup once it's unwanted”      | `Cancel` of recovery, with focused started-row recovery plus “a failed call whose job became unwanted meanwhile is never looked up” exercising the real validity guard and unknown/unreleased result.                                                                                             |

Kept deliberately: the during-usage cost test, owner-edit/forget epoch tests,
both transaction rollback tests, the exact daily limits, retry-per-chunk query,
multi-dot concurrency, real timeout, full paged usage, compaction and privacy
tests. TLA cannot replace their implementation and storage evidence.

# Feed and avatar protocols

These models replace hand-picked interleavings, not the renderer, network or image
decoder. `bun run model:check` explores the TLA+ state graphs using pinned
`tla-ts` 0.0.8. `bun run model:negative` checks intentionally broken copies under
ignored `.research/model-negative/`; each must exit 12 with its named invariant.
The controls keep the original bounds but select the targeted invariant so the
order of other violations does not obscure the result.

## Feed

`Feed.tla` follows `FeedState` in `app/surfaces.ts`:

| Action           | Concrete correspondence                                                                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dismiss`        | `dismiss`: hide IDs, clear their restored entries, remove visible items.                                                                                                                 |
| `Finish`         | `finish`: advance the event counter; successful IDs remain hidden and enter `done`; failed IDs return with their settlement event.                                                       |
| `StartPoll`      | `startPoll`: capture event counter, poll sequence and a copy of completed dismissals.                                                                                                    |
| `Apply` / `Drop` | `apply` / `isCurrent`: only the newest started poll applies; release dismissals captured at poll start, expire older restorations, filter hidden items and merge protected restorations. |

Bounds: two item IDs, each dismissed at most once, three polls. Poll contents may
be any subset, including missing failed items and reappearing successful items.
Completions can interleave with starts and responses in every permitted order.
A batch finish is split into per-item finishes: this over-approximates callback
interleavings; the implementation updates a batch synchronously. IDs stand for
items, not payloads. The two-item bound covers partial success; it does not prove
arbitrary batch sizes or repeated dismissals of the same item.

Invariants check types, hidden/pending item invisibility, preservation of failed
items until a sufficiently fresh poll, successful dismissal protection until a
fresh poll, and rejection of superseded polls. The `staleApplied` history flag
records whether an actual apply transition accepted an obsolete poll; it is not
an assumption in the initial state about future behavior. Negative controls
remove the current-poll guard and remove restoration merging, respectively.

Retained concrete checks:

- `surfaces`: “feed reconciliation fences polls, restores failed items and keeps
  new arrivals” calls the actual class, checks mixed outcomes, error association,
  a stale poll and a fresh poll.
- “a lost clear keeps the whole bounded snapshot and the overflow” keeps the
  real 1,000-item limit, overflow and retry path outside the two-ID model.
- The complete Electron “Feed: dismiss and Clear all…” case remains, including
  bridge wiring and real rendered state. Feed reply delivery tests are untouched;
  this is not an outbox or multi-dot reply model.

Three scenario declarations are removed: “a poll begun before a clear can't
bring it back after a newer poll settles it”, “a poll in flight during a clear
keeps cleared items hidden until a fresh poll”, and “a failure survives an older
poll, and a newer poll decides”. Their ordering properties are now the graph's
invariants; the retained concrete check ties those guards to TypeScript.

## Avatar

`Avatar.tla` follows `AvatarState` in `app/surfaces.ts`. `Update` sets the listed
revision and starts a load only if neither `done` nor `loading` names it. `Forget`
clears all four maps for an absent dot/avatar. `Finish` accepts only a currently
listed and loading revision, marks it done and either publishes the image or
clears it on decode failure. `Abandon` clears only a matching loading revision,
allowing the next poll to retry. `Drop` consumes an unwanted late response.

Bounds: one dot, two revision identities plus absent. Updates, deletion,
reintroduction, failures and completion cycles are unbounded in a finite graph.
Outstanding callbacks are a set of revision identities. Multiple callbacks for
identical bytes are collapsed: this does not prove callback multiplicity or an
ABA defense. Revision equality is assumed to identify the same image bytes.
Different dots' maps are assumed independent, and retained tests exercise that
concrete keying. No decoding, byte validity, HTTP status or object URL lifetime
is modeled.

Invariants check types, emptiness after deletion, acceptance only of a wanted
revision, no load of an already completed or still-loading revision, and keeping
the old image during replacement. `NeedsLoad` explicitly represents the load
decision, so starting an identical pending request is observable even though
`flights` collapses callback multiplicity. History flags remember forbidden
transition effects. Controls remove the pending-load guard, remove the
completion guards and retain an image through `Forget`.

Three scenario declarations are removed: “each avatar revision loads once, and
a dot without one shows none”, “a replaced avatar keeps the old image until the
new one loads, and a stale load is dropped”, and “a deleted avatar clears at
once, and a late load can't bring it back”. The retained, focused “avatar
revision guards distinguish failed requests, undecodable bytes and stale
completions” calls the real class across two dot keys. The real Electron avatar
test, all image byte/size tests, and all filesystem/HTTP avatar tests remain.

## Limits

Neither model has fairness or liveness claims. Stuttering is allowed, so no
deadlock/progress claim is made. UI state updates are synchronous between
callbacks. The model checker does not execute TypeScript and there is no proved
refinement mapping. The retained implementation checks are deliberate
correspondence samples, not a claim of complete implementation equivalence.

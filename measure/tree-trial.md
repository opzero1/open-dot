# Hierarchical memory trial, version 1

This experiment tests a chronological tree of the dot's existing, source-linked observations. It does not test a new summarization model. The tree uses extractive summaries: selected text from existing observations, not newly generated claims. Recent source detail stays detailed; older ranges have shorter summaries that can be expanded to their observations and archived messages.

The design is independent. It uses open-dot's own archive, ledger and tombstones, with no external memory service or copied implementation.

## What stays fixed

- The live baseline includes the owner-source-slot fix. The tree is shadow-only: it never replaces the context sent to a model.
- Both arms use the same incoming owner query and the same existing head, notes and since-checkpoint context. Each alternative recall block has the same maximum of three records and 4,800 UTF-8 bytes, including framing.
- Owner-approved facts stay outside the tree and keep their authority. A summary is source-derived data, not an instruction or approval.
- The trial does not turn on archive, observer, ledger or any other memory layer. It requires the relevant existing layers and ready session. A change to the frozen settings or binding pauses collection rather than mixing configurations.
- No new model call or background model job is added. Additional summarization tokens and monetary cost are zero. The existing observer still has its configured model and daily budget; its work is not free or charged to this tree as a new call.
- Native/encrypted compaction does not collect tree comparisons. Existing context and compaction behavior remain the baseline.

Each build is bounded to 512 current observations and 64 recent archived messages. A node summary is at most 1,200 UTF-8 bytes. Coverage beyond those inputs is unavailable, not silently represented as a complete archive index. Trees are derived from current sources rather than kept as another durable copy of private text.

More than 1,024 forget tombstones pauses collection and blocks content inspection; the trial never treats an unread tombstone as safe. Long observations use bounded extracts with their original provenance. A leaf whose metadata cannot fit reports an omitted pointer and receives no coverage credit. Source checks still depend on SQLite queries over the dot's metadata, so the row caps are not a constant-time guarantee for an arbitrarily large database.

## Freeze the window before starting

Run one version for **14 consecutive days**, starting only after coordinator review and explicit activation for a named dot. Record the start, end, protocol version, baseline version, binding and settings before the first sample. The suggested first window is **November 6–20, 2026**, at the same UTC activation time on both dates. If activation happens later, record the actual dates before collection; do not backdate the trial.

Collect at most 20 paired queries per UTC day and 280 per run. Repeated requests for the same owner message count once, including after a restart. Turning the trial off stops collection. Expiry never silently extends the window. A different design or parameter choice needs a new version and a new window; preserve the previous result before replacing its bounded local samples.

Do not tune version 1 against questions collected during its window. A bug affecting privacy, forgotten content or scope stops the run. A repaired version starts a separate window rather than being pooled with the earlier one.

## What the measurements mean

Automatic measurements are **retrieval proxies**, not answer scores:

- Source references displayed by each arm, their overlap and references unique to either arm.
- Known associations with superseded sources, where the ledger supplies that evidence. An association is not proof that the displayed text makes an obsolete claim; a corrected observation can cite an older message.
- Rendered context bytes and local retrieval/build latency.
- Additional model tokens and cost, which are zero for this extractive design.

Keep source identity separate from answer support. A summary citing the right message may omit the requested detail. A larger set of source IDs cannot by itself establish a benefit. These measurements also do not establish model-answer accuracy, abstention, provider-cache savings or lower end-to-end model latency.

The collector uses a zero SQLite busy timeout and drops a sample rather than waiting for another writer; the previous timeout is restored. Dropped samples are unmeasured, not successful comparisons. Reported collector preparation time excludes the final transaction/commit and pragma changes. Real contention frequency and full request overhead remain to be measured during an approved trial.

Sample storage must not duplicate query or summary text. Inspection rereads authorized sources using saved references, versions, hashes and extractive positions. A source that changed, was forgotten or is unavailable must be reported as unavailable, not shown as if it were the captured evidence. A current source read must be distinguished from an exactly reconstructed captured excerpt. Queries not yet archived may be unavailable for inspection.

## Make a decision, not just a log

At the end, use the frozen sample order, not a search for favorable examples. Review up to the first 20 available comparisons in timestamp/ID order, distributed over both weeks where available. Record how many were unavailable or invalidated. For each, inspect the source-supported displayed detail and record one label:

- **Tree better:** it supplies a useful, source-supported detail the baseline lacks, without a material loss or misleading correction.
- **Baseline better:** the reverse, or the tree introduces a material misleading implication.
- **Tie:** neither is materially better for this query.
- **Insufficient evidence:** the source or question cannot support a judgment.

Before claiming a useful result, require at least **40 paired queries**, **10 in each week**, and **20 source-supported reviews**. Otherwise conclude insufficient evidence. Do not silently extend the same run until it reaches the threshold.

Benefit requires more tree-better than baseline-better reviews, no material correction/forget/isolation failure, and no context-budget breach. Report exact paired counts, harm examples, unavailable samples and latency distribution. A tie or a result favoring the baseline means no demonstrated benefit. Do not hide harms in an average or treat more source references as a win.

A favorable result still does not authorize replacing live context. That requires a separate compatibility and source-support review. Until then, the tree remains a reversible shadow experiment.

## Owner controls and inspection

These routes use the daemon's existing local owner authentication. They do not call OpenCode or change an observer setting. There is no model tool that turns the trial on and no new app UI. All paths below begin with `/dots/<name>/memory/tree`.

| Method | Suffix                            | Use                                                                                         |
| ------ | --------------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | none                              | Status, frozen run settings, window, limits and counters.                                   |
| PUT    | none                              | Exactly `{"enabled":true}` to start, or `{"enabled":false}` to stop.                        |
| GET    | `/report`                         | Paired proxies, latency distributions, review set and decision eligibility.                 |
| GET    | `/samples`                        | The bounded run's sample identifiers and metrics, without text.                             |
| GET    | `/samples/<id>`                   | Validate and inspect the query and the two arms' captured references.                       |
| GET    | `/samples/<id>/sources/<message>` | Read a credited source, labelled as current source text; captured excerpts are separate.    |
| PUT    | `/samples/<id>/review`            | Exactly `{"review":"tree"}`, `"baseline"`, `"tie"` or `"insufficient"` as the review value. |
| GET    | `/nodes`                          | Current top-level ranges, their coverage and child paths.                                   |
| GET    | `/nodes/<path>`                   | Expand a current node, for example `o4.1.0`; this is not a captured historical node.        |

Routes reject query parameters, extra body keys and bodies over 1 KiB. Repeating `enabled:true` while already on preserves the same run and end time, including after expiry. Stop and then start explicitly to create a new run; that replaces the prior run's bounded samples. Save the old aggregate result before doing so. Stopping alone keeps samples for review, while disabling the archive withholds source content. There is no live-context mode to switch on.

For a sampled comparison, start with the report's `reviewSet`, inspect each sample's query and captured references, and open credited originals when needed. Do not label a missing or changed query as source-supported. Keep unavailable samples and known scope differences visible: the candidate uses the bound session only, whereas the unchanged baseline can include a current observation from an earlier session of the same dot. Nodes use observation-count ranges, not fixed calendar buckets. Recent message excerpts start at the beginning, so a fact deep inside a long message can remain undiscovered. These are limits of version 1, not reasons to tune its window midway.

## Recommended activation, after review

This branch does not activate the trial. The coordinator should first check compatibility and read each intended dot's existing `GET /dots/<name>/memory/archive` and tree status. For an already-enabled Jotaro or Jolyne, the only proposed change is `PUT /dots/<name>/memory/tree` with `{"enabled":true}`. Preserve that dot's existing observer model and daily token budget. Additional tree model calls, tokens and cost are zero. Do not turn on memory layers merely to satisfy the trial prerequisites, and leave Josuke off.

Use the November 6–20 window above if activation is approved in time; the API records the actual activation timestamp and exactly 14 days after it. If deployment or review is later, declare the shifted dates before activation. No service restart, rollout or settings change is implied by publishing the experiment code.

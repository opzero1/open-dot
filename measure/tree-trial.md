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

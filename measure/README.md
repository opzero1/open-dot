# Recall measurement (#42)

`run.ts` builds what a dot would see for each question with the plugin's own functions. `composeTurn` gives the checkpoint, the listed notes and the tail, and `recallResults` gives `dot_recall`. It does this for four arms, with that arm's switches set on an in-memory database:

| Arm       | What the dot sees                                                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `today`   | The fixture's frozen compaction `summary` and the newest `visibleTail` messages after it.                                                     |
| `b`       | `today`, plus `dot_recall` for the question's three longest uncommon words. This stands in for the dot choosing its own search.               |
| `b+d1`    | `b`, plus automatic recall for the question as the owner's latest message.                                                                    |
| `b+d1+d3` | `b+d1`, plus the ledger: the checkpoint for the context's text compaction, observed rows in recall, and the "since the last checkpoint" list. |

It scores retrieval: whether the answer text or its source message ID is in that view. Nothing calls a model, OpenCode or the network, and nothing opens the live open-dot database.

```
bun measure/run.ts                                  # the synthetic fixture
bun measure/run.ts --details                        # per-question results too
bun measure/run.ts --fixture <path> --private       # the owner's private fixture
bun measure/run.ts --fixture <path> --private --import <scores.json>
```

## Imported answer scores and provider tokens

Answer accuracy and provider cache counts need a live run, which this harness never makes. Whoever runs one records it as JSON and passes it with `--import`:

```json
{
  "fixtureSHA256": "<the report's fixtureSHA256>",
  "arms": {
    "today": {
      "q01": { "steps": [{ "answerScore": 1, "cachedTokens": 1200, "uncachedTokens": 300 }] }
    },
    "b": { "q01": { "steps": [] } },
    "b+d1": {},
    "b+d1+d3": {}
  }
}
```

The import is refused when any of these hold:

- It names another fixture.
- It doesn't have exactly the four arms.
- It names a question the fixture lacks.
- A score is outside 0 to 1.
- A token count isn't a whole number.

Every model request a question takes is a step. The report keeps every step's own `cachedTokens` and `uncachedTokens` exactly as imported, and `cachedDelta`, the plain change in cached tokens from the step before. It doesn't diagnose cache breaks: provider minimums and block sizes, cache boundaries, expiry and changed input all move these counts, and the counters alone can't tell which. A step without counters, and the step after it, have `cachedDelta` `unavailable`. A question, score or counter the import lacks is reported as missing or `unavailable`, never estimated. Without `--import`, the report says answer scores and provider tokens are unavailable. `addedTokensEstimate` is each arm's added bytes divided by 4, an estimate, not a provider count.

## The shipped fixture

`synthetic.json` is entirely made up:

- 40 questions, 16 of them paraphrases, about a fictional project, Orchard.
- 440 messages.
- A short frozen summary.
- 20 ledger rows written by hand, not by an observer.

Its scores check that the harness works and say nothing about real use.

## Private source-backed measurements

After some real use, the owner writes a private fixture with the same shape, `"synthetic": false`. It needs:

- 30 to 50 questions about real early facts, including paraphrases, each naming its source message.
- The frozen summary the dot actually had.
- Optionally, the ledger rows the observer actually wrote.

Keep it outside the repository, for example under `~/.opendot/evidence/issue-42/`. Never commit it, and never paste its contents into an issue.

A bounded pilot on November 5, 2026 used a consistent, read-only export of two enabled dots' memory tables: 2,033 archived messages, 159 actual observations and 5 notes. Thirty questions were frozen before scoring or tuning: 27 answerable and 3 negative controls, including older decisions, paraphrases and corrections. Private source text and results remain in ignored local evidence, not this repository's tracked files.

The pilot found that three observer matches could exclude a strongly matching original owner message. Reserving one of those slots for the strongest qualifying owner hit improved source-and-displayed-answer recovery from 11 to 15 of 27 questions in composed memory, and from 8 to 14 in the automatic block alone. No earlier recovery was lost or known obsolete alternative added. Automatic context decreased from 61,176 to 60,482 total UTF-8 bytes across the 30 questions, under the unchanged three-record/4,800-byte cap per question. Unrelated automatic records decreased from 30 to 26, but one question gained an unrelated record; that relevance regression remains.

These are manually checked source recoveries, not generated-answer accuracy or provider cache savings. Source-ID presence alone did not count: a displayed excerpt or observation had to support the answer too. The replay used the saved settings, checkpoint and current compaction mode, with six recent messages visible, not the complete live model context. Twelve full-memory source misses remain, including older-session and lexical-matching gaps. The pilot supports the small slot-allocation change, not a hierarchical memory rewrite or a general recall-quality claim.

A separate validation froze 16 new questions after both code versions were fixed, then replayed them against the same snapshot without tuning. Fourteen were answerable, all with sources at least seven days old; two asked for unsupported details. Eight used paraphrases and three distinguished later decisions from earlier alternatives. Their primary sources did not overlap the development pilot's permitted or stale sources. This is post-development validation within an already inspected corpus, not a prospective or unseen-corpus holdout.

Neither version did better: complete source-and-displayed-answer recovery was 5/14 in automatic recall and 6/14 in composed memory. Allowing any displayed source, including notes without rendered provenance, gave 7/14 in composed memory. These strict scores require the full frozen expected answer; three misses still supplied the central question facts but omitted supplementary caveats. Only one output changed, replacing an unrelated observation with an unrelated owner message and saving 194 bytes. There were no recovery losses, new known obsolete claims or per-question unrelated-record-count regressions. Neither control exposed an invented requested value; this does not test whether a model would abstain.

The validation does not demonstrate broader superiority. Remaining problems include generic lexical matches, observations omitting details, citations to multi-topic messages without the needed text, and observation-first allocation excluding useful assistant-authored archive hits. Historical dates are not retrieval cutoffs, and a capped checkpoint can list a topic without its supporting fact. The owner-slot change addresses only one of these mechanisms. Both versions retained the existing byte caps, dot/session isolation, visible-message exclusion and bounded cached-deletion behavior. No model jobs, live changes or further runtime edits were made for this validation.

## Experimental chronological tree

The separate [tree trial protocol](tree-trial.md) fixes a 14-day, per-dot shadow comparison before tuning. It reuses source-linked observer sentences, adds no model calls, and does not replace live context. Its source-coverage proxies and sampled owner reviews are separate from the development and fixed-candidate results above. Building the experiment is not evidence that it improves recall.

## Where the memory tail goes (#62)

`cache.ts` scores the prompt cache cost of the plugin's tail placement against putting the tail after the owner's message, with the plugin's own `placeTail`, OpenCode 2.2.0's automatic cache hints and Anthropic's prefix cache. It calls no model or OpenCode, and its token sizes are a scenario's, not provider counts:

```
bun measure/cache.ts
```

The result, and why the placement stays, is in `docs/PLAN.md` under "Verified OpenCode behavior".

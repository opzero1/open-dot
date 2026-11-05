---- MODULE Feed ----
EXTENDS Naturals, FiniteSets
CONSTANT MaxPolls
VARIABLES visible, hiding, done, restored, events, polls, reads, at, settled, pending, cleared, staleApplied

Items == {1, 2}
Polls == 1..MaxPolls
vars == <<visible, hiding, done, restored, events, polls, reads, at, settled, pending, cleared, staleApplied>>

Init ==
    /\ visible = Items /\ hiding = {} /\ done = {}
    /\ restored = [i \in Items |-> 0]
    /\ events = 0 /\ polls = 0 /\ reads = {}
    /\ at = [p \in Polls |-> 0] /\ settled = [p \in Polls |-> {}]
    /\ pending = {} /\ cleared = {} /\ staleApplied = FALSE

Dismiss(ids) ==
    /\ ids # {} /\ ids \subseteq (visible \ cleared)
    /\ visible' = visible \ ids /\ hiding' = hiding \cup ids
    /\ pending' = pending \cup ids /\ cleared' = cleared \cup ids
    /\ restored' = [i \in Items |-> IF i \in ids THEN 0 ELSE restored[i]]
    /\ UNCHANGED <<done, events, polls, reads, at, settled, staleApplied>>

Finish(i, success) ==
    /\ i \in pending
    /\ events' = events + 1 /\ pending' = pending \ {i}
    /\ done' = IF success THEN done \cup {i} ELSE done
    /\ hiding' = IF success THEN hiding ELSE hiding \ {i}
    /\ restored' = [restored EXCEPT ![i] = IF success THEN 0 ELSE events + 1]
    /\ visible' = IF success THEN visible ELSE visible \cup {i}
    /\ UNCHANGED <<polls, reads, at, settled, cleared, staleApplied>>

StartPoll ==
    /\ polls < MaxPolls
    /\ polls' = polls + 1 /\ reads' = reads \cup {polls + 1}
    /\ at' = [at EXCEPT ![polls + 1] = events]
    /\ settled' = [settled EXCEPT ![polls + 1] = done]
    /\ UNCHANGED <<visible, hiding, done, restored, events, pending, cleared, staleApplied>>

Apply(p, listed) ==
    /\ p \in reads /\ p = polls
    /\ reads' = reads \ {p}
    /\ hiding' = hiding \ settled[p] /\ done' = done \ settled[p]
    /\ restored' = [i \in Items |-> IF restored[i] <= at[p] THEN 0 ELSE restored[i]]
    /\ visible' = (listed \ (hiding \ settled[p])) \cup
        {i \in Items : restored[i] > at[p] /\ i \notin (hiding \ settled[p])}
    /\ staleApplied' = (staleApplied \/ p # polls)
    /\ UNCHANGED <<events, polls, at, settled, pending, cleared>>

Drop(p) ==
    /\ p \in reads /\ p # polls /\ reads' = reads \ {p}
    /\ UNCHANGED <<visible, hiding, done, restored, events, polls, at, settled, pending, cleared, staleApplied>>

Next ==
    \/ \E ids \in SUBSET Items : Dismiss(ids)
    \/ \E i \in Items, success \in BOOLEAN : Finish(i, success)
    \/ StartPoll
    \/ \E p \in Polls, listed \in SUBSET Items : Apply(p, listed)
    \/ \E p \in Polls : Drop(p)
    \/ UNCHANGED vars

TypeOK ==
    /\ visible \subseteq Items /\ hiding \subseteq Items /\ done \subseteq Items
    /\ pending \subseteq Items /\ cleared \subseteq Items /\ reads \subseteq Polls
    /\ events \in 0..2 /\ polls \in 0..MaxPolls
    /\ restored \in [Items -> 0..2] /\ at \in [Polls -> 0..2]
    /\ settled \in [Polls -> SUBSET Items] /\ staleApplied \in BOOLEAN
HiddenStayHidden == visible \cap hiding = {}
FailuresStayVisible == \A i \in Items : restored[i] > 0 => i \in visible
SuccessWaitsForFreshPoll == done \subseteq hiding
PendingStayHidden == pending \subseteq hiding
OnlyLatestPollApplies == ~staleApplied
====

---- MODULE Observer ----
EXTENDS Naturals
VARIABLES job, pc, valid, ids, charged, calls, admitted, released, applied, unsafeRead, unsafeApply, knownUsage, recordedUsage
Final == {"done", "failed", "cancelled", "unknown"}
vars == <<job, pc, valid, ids, charged, calls, admitted, released, applied, unsafeRead, unsafeApply, knownUsage, recordedUsage>>

Init ==
    /\ job = "queued" /\ pc = "idle" /\ valid = TRUE
    /\ ids = FALSE /\ charged = FALSE /\ calls = 0 /\ admitted = FALSE
    /\ released = FALSE /\ applied = FALSE /\ unsafeRead = FALSE /\ unsafeApply = FALSE
    /\ knownUsage = FALSE /\ recordedUsage = FALSE

Invalidate ==
    /\ valid /\ valid' = FALSE
    /\ UNCHANGED <<job, pc, ids, charged, calls, admitted, released, applied, unsafeRead, unsafeApply, knownUsage, recordedUsage>>

Claim ==
    /\ job = "queued" /\ pc = "idle" /\ valid
    /\ job' = "started" /\ pc' = "creating" /\ ids' = TRUE
    /\ UNCHANGED <<valid, charged, calls, admitted, released, applied, unsafeRead, unsafeApply, knownUsage, recordedUsage>>

Created(result) ==
    /\ pc = "creating"
    /\ job' = IF result = "unknown" THEN "unknown" ELSE IF result = "no" THEN "failed" ELSE IF ~valid THEN "cancelled" ELSE "started"
    /\ pc' = IF valid /\ result = "yes" THEN "ready" ELSE "idle"
    /\ released' = (result = "no" \/ (result = "yes" /\ ~valid))
    /\ UNCHANGED <<valid, ids, charged, calls, admitted, applied, unsafeRead, unsafeApply, knownUsage, recordedUsage>>

Prompt ==
    /\ job = "started" /\ pc = "ready" /\ valid /\ calls < 2
    /\ charged' = TRUE /\ calls' = calls + 1 /\ pc' = "calling"
    /\ UNCHANGED <<job, valid, ids, admitted, released, applied, unsafeRead, unsafeApply, knownUsage, recordedUsage>>

PromptResult(accepted, reply) ==
    /\ pc = "calling" /\ (reply => accepted)
    /\ admitted' = (admitted \/ accepted)
    /\ job' = IF reply THEN IF valid THEN "running" ELSE "cancelled" ELSE "started"
    /\ pc' = IF reply THEN "idle" ELSE "lookup"
    /\ UNCHANGED <<valid, ids, charged, calls, released, applied, unsafeRead, unsafeApply, knownUsage, recordedUsage>>

Lookup ==
    /\ pc \in {"lookup", "recover"} /\ valid
    /\ pc' = IF pc = "lookup" THEN "checking" ELSE "recovering"
    /\ unsafeRead' = (unsafeRead \/ ~valid)
    /\ UNCHANGED <<job, valid, ids, charged, calls, admitted, released, applied, unsafeApply, knownUsage, recordedUsage>>

LookedUp(known) ==
    /\ pc \in {"checking", "recovering"}
    /\ job' = IF ~known THEN "unknown" ELSE IF admitted THEN
        IF valid THEN "running" ELSE "cancelled"
        ELSE IF pc = "checking" THEN "failed" ELSE "unknown"
    /\ released' = (released \/ (known /\ ~admitted /\ pc = "checking"))
    /\ pc' = "idle"
    /\ UNCHANGED <<valid, ids, charged, calls, admitted, applied, unsafeRead, unsafeApply, knownUsage, recordedUsage>>

Crash(accepted) ==
    /\ job = "started" /\ pc # "recover"
    /\ (accepted => pc = "calling")
    /\ admitted' = (admitted \/ accepted) /\ pc' = "recover"
    /\ UNCHANGED <<job, valid, ids, charged, calls, released, applied, unsafeRead, unsafeApply, knownUsage, recordedUsage>>

Turn ==
    /\ job = "running" /\ pc = "idle" /\ valid
    /\ pc' = "turn" /\ unsafeRead' = (unsafeRead \/ ~valid)
    /\ UNCHANGED <<job, valid, ids, charged, calls, admitted, released, applied, unsafeApply, knownUsage, recordedUsage>>

Usage ==
    /\ job = "running" /\ pc = "turn" /\ valid
    /\ pc' = "usage" /\ unsafeRead' = (unsafeRead \/ ~valid)
    /\ UNCHANGED <<job, valid, ids, charged, calls, admitted, released, applied, unsafeApply, knownUsage, recordedUsage>>

UsageResult(known) ==
    /\ pc = "usage"
    /\ knownUsage' = known /\ recordedUsage' = known
    /\ pc' = "apply"
    /\ UNCHANGED <<job, valid, ids, charged, calls, admitted, released, applied, unsafeRead, unsafeApply>>

Apply ==
    /\ job = "running" /\ pc = "apply" /\ valid
    /\ job' = "done" /\ pc' = "idle" /\ applied' = TRUE
    /\ unsafeApply' = (unsafeApply \/ ~valid)
    /\ UNCHANGED <<valid, ids, charged, calls, admitted, released, unsafeRead, knownUsage, recordedUsage>>

Cancel ==
    /\ ~valid /\ job \notin Final
    /\ pc \in {"idle", "ready", "lookup", "recover", "turn", "apply"}
    /\ job' = IF pc \in {"lookup", "recover"} THEN "unknown" ELSE "cancelled"
    /\ released' = (released \/ pc = "ready") /\ pc' = "idle"
    /\ UNCHANGED <<valid, ids, charged, calls, admitted, applied, unsafeRead, unsafeApply, knownUsage, recordedUsage>>

Next ==
    \/ Claim \/ Prompt \/ Lookup \/ Turn \/ Usage \/ Apply \/ Cancel \/ Invalidate
    \/ \E r \in {"yes", "no", "unknown"} : Created(r)
    \/ \E a, r \in BOOLEAN : PromptResult(a, r)
    \/ \E known \in BOOLEAN : LookedUp(known) \/ UsageResult(known)
    \/ \E accepted \in BOOLEAN : Crash(accepted)
    \/ UNCHANGED vars

TypeOK ==
    /\ job \in {"queued", "started", "running"} \cup Final
    /\ pc \in {"idle", "creating", "ready", "calling", "lookup", "checking", "recover", "recovering", "turn", "usage", "apply"}
    /\ calls \in 0..2
    /\ valid \in BOOLEAN /\ ids \in BOOLEAN /\ charged \in BOOLEAN /\ admitted \in BOOLEAN
    /\ released \in BOOLEAN /\ applied \in BOOLEAN /\ unsafeRead \in BOOLEAN /\ unsafeApply \in BOOLEAN
    /\ knownUsage \in BOOLEAN /\ recordedUsage \in BOOLEAN
PersistBeforePrompt == calls > 0 => ids /\ charged
NoPromptReplay == calls <= 1
ReleaseOnlyUnadmitted == released => ~admitted
NoUnwantedRead == ~unsafeRead
NoUnwantedApply == ~unsafeApply
KnownCostRecorded == knownUsage => recordedUsage
AppliedMeansAdmitted == applied => admitted
====

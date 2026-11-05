---- MODULE Outbox ----
EXTENDS Naturals
CONSTANT MaxCalls
VARIABLES row, started, allowed, admitted, calls, admissions, gate, pc, unsafe

Callers == {1, 2}
vars == <<row, started, allowed, admitted, calls, admissions, gate, pc, unsafe>>

Init ==
    /\ row = "pending"
    /\ started = FALSE
    /\ allowed = TRUE
    /\ admitted = FALSE
    /\ calls = 0
    /\ admissions = 0
    /\ gate = 0
    /\ pc = [c \in Callers |-> "idle"]
    /\ unsafe = FALSE

Begin(c) ==
    /\ gate = 0 /\ row = "pending" /\ (started \/ allowed)
    /\ gate' = c
    /\ pc' = [pc EXCEPT ![c] = "lookup"]
    /\ started' = TRUE
    /\ UNCHANGED <<row, allowed, admitted, calls, admissions, unsafe>>

CancelUnstarted ==
    /\ gate = 0 /\ row = "pending" /\ ~started /\ ~allowed
    /\ row' = "cancelled"
    /\ UNCHANGED <<started, allowed, admitted, calls, admissions, gate, pc, unsafe>>

Lookup(c) ==
    /\ gate = c /\ pc[c] = "lookup"
    /\ pc' = [pc EXCEPT ![c] = IF admitted THEN "ack" ELSE "absent"]
    /\ UNCHANGED <<row, started, allowed, admitted, calls, admissions, gate, unsafe>>

LookupFailed(c) ==
    /\ gate = c /\ pc[c] = "lookup"
    /\ gate' = 0 /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ UNCHANGED <<row, started, allowed, admitted, calls, admissions, unsafe>>

Cancel(c) ==
    /\ gate = c /\ pc[c] = "absent" /\ ~allowed
    /\ row' = "cancelled"
    /\ gate' = 0 /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ UNCHANGED <<started, allowed, admitted, calls, admissions, unsafe>>

Prompt(c) ==
    /\ gate = c /\ pc[c] = "absent" /\ allowed
    /\ calls < MaxCalls
    /\ calls' = calls + 1
    /\ unsafe' = (unsafe \/ ~allowed)
    /\ pc' = [pc EXCEPT ![c] = "calling"]
    /\ UNCHANGED <<row, started, allowed, admitted, admissions, gate>>

Resolve(c, accepted, reply) ==
    /\ gate = c /\ pc[c] = "calling"
    /\ admitted' = (admitted \/ accepted)
    /\ admissions' = admissions + (IF accepted THEN 1 ELSE 0)
    /\ pc' = [pc EXCEPT ![c] = IF accepted /\ reply THEN "ack" ELSE "idle"]
    /\ gate' = IF accepted /\ reply THEN c ELSE 0
    /\ UNCHANGED <<row, started, allowed, calls, unsafe>>

Confirm(c) ==
    /\ gate = c /\ pc[c] = "ack"
    /\ row' = "sent"
    /\ gate' = 0 /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ UNCHANGED <<started, allowed, admitted, calls, admissions, unsafe>>

Revoke ==
    /\ allowed /\ allowed' = FALSE
    /\ UNCHANGED <<row, started, admitted, calls, admissions, gate, pc, unsafe>>

Crash(accepted) ==
    /\ gate # 0
    /\ (accepted => pc[gate] = "calling")
    /\ admitted' = (admitted \/ accepted)
    /\ admissions' = admissions + (IF accepted THEN 1 ELSE 0)
    /\ gate' = 0 /\ pc' = [c \in Callers |-> "idle"]
    /\ UNCHANGED <<row, started, allowed, calls, unsafe>>

Next ==
    \/ \E c \in Callers : Begin(c) \/ Lookup(c) \/ LookupFailed(c) \/ Cancel(c)
                            \/ Prompt(c) \/ Confirm(c)
                            \/ (\E a, r \in BOOLEAN : Resolve(c, a, r))
    \/ Revoke
    \/ CancelUnstarted
    \/ \E a \in BOOLEAN : Crash(a)
    \/ UNCHANGED vars

TypeOK ==
    /\ row \in {"pending", "sent", "cancelled"}
    /\ started \in BOOLEAN /\ allowed \in BOOLEAN /\ admitted \in BOOLEAN
    /\ calls \in 0..MaxCalls /\ admissions \in 0..MaxCalls
    /\ gate \in {0, 1, 2} /\ unsafe \in BOOLEAN
    /\ pc \in [Callers -> {"idle", "lookup", "absent", "calling", "ack"}]
PersistBeforeCall == calls > 0 => started
NoDuplicateAdmission == admissions <= 1
NoUnauthorizedCall == ~unsafe
SentMeansAdmitted == row = "sent" => admitted
CancelledMeansAbsent == row = "cancelled" => ~admitted
====

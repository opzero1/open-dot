---- MODULE Supervision ----
EXTENDS Naturals, FiniteSets
VARIABLES active, seen, seenIDs, told, reports, waitingReports, snapshot, waiting, reading, unauthorized, missed
Ends == {0, 1, 2, 3}
Requests == {1, 2}
Time(e) == IF e = 0 THEN 0 ELSE IF e = 3 THEN 2 ELSE 1
vars == <<active, seen, seenIDs, told, reports, waitingReports, snapshot, waiting, reading, unauthorized, missed>>

Init ==
    /\ active = TRUE /\ seen = 0 /\ seenIDs = {} /\ told = {}
    /\ reports = [e \in Ends |-> 0] /\ waitingReports = [r \in Requests |-> 0]
    /\ snapshot = {} /\ waiting = {} /\ reading = FALSE
    /\ unauthorized = FALSE /\ missed = FALSE

Read(ends, requests) ==
    /\ active /\ ~reading
    /\ snapshot' = ends /\ waiting' = requests /\ reading' = TRUE
    /\ UNCHANGED <<active, seen, seenIDs, told, reports, waitingReports, unauthorized, missed>>

Fresh == {e \in snapshot : Time(e) > seen \/ (Time(e) = seen /\ seenIDs # {} /\ e \notin seenIDs)}
Newest == IF 3 \in Fresh THEN 2 ELSE IF Fresh # {} THEN 1 ELSE seen
Commit ==
    /\ reading /\ active
    /\ seen' = Newest
    /\ seenIDs' = (IF Newest = seen THEN seenIDs ELSE {}) \cup {e \in Fresh : Time(e) = Newest}
    /\ reports' = [e \in Ends |-> reports[e] + (IF e \in Fresh THEN 1 ELSE 0)]
    /\ waitingReports' = [r \in Requests |-> waitingReports[r] + (IF r \in waiting \ told THEN 1 ELSE 0)]
    /\ told' = told \cup waiting /\ reading' = FALSE
    /\ unauthorized' = (unauthorized \/ ~active)
    /\ missed' = (missed \/ (\E e \in snapshot : Time(e) >= seen /\ Time(e) > 0 /\ reports'[e] = 0))
    /\ UNCHANGED <<active, snapshot, waiting>>

Revoke ==
    /\ active /\ active' = FALSE
    /\ UNCHANGED <<seen, seenIDs, told, reports, waitingReports, snapshot, waiting, reading, unauthorized, missed>>

Abort ==
    /\ reading /\ reading' = FALSE
    /\ UNCHANGED <<active, seen, seenIDs, told, reports, waitingReports, snapshot, waiting, unauthorized, missed>>

Next ==
    \/ \E ends \in SUBSET Ends, requests \in SUBSET Requests : Read(ends, requests)
    \/ Commit \/ Revoke \/ Abort
    \/ UNCHANGED vars

TypeOK ==
    /\ active \in BOOLEAN /\ reading \in BOOLEAN /\ unauthorized \in BOOLEAN /\ missed \in BOOLEAN
    /\ seen \in 0..2 /\ seenIDs \subseteq Ends /\ told \subseteq Requests
    /\ snapshot \subseteq Ends /\ waiting \subseteq Requests
    /\ reports \in [Ends -> 0..2] /\ waitingReports \in [Requests -> 0..2]
NoDuplicateTurn == \A e \in Ends : reports[e] <= 1
NoDuplicateWaiting == \A r \in Requests : waitingReports[r] <= 1
ActivationExcluded == reports[0] = 0
NoNoticeAfterRevoke == ~unauthorized
NoEligibleEndMissed == ~missed
====

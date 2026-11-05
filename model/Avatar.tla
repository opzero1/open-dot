---- MODULE Avatar ----
EXTENDS Naturals
VARIABLES listed, loading, done, image, flights, stalePublished, duplicateLoad, replacementLost
Revisions == {1, 2}
Values == {0, 1, 2}
NeedsLoad(r) == done # r /\ loading # r
vars == <<listed, loading, done, image, flights, stalePublished, duplicateLoad, replacementLost>>

Init ==
    /\ listed = 0 /\ loading = 0 /\ done = 0 /\ image = 0
    /\ flights = {} /\ stalePublished = FALSE /\ duplicateLoad = FALSE /\ replacementLost = FALSE

Update(r) ==
    /\ r \in Revisions
    /\ listed' = r
    /\ loading' = IF NeedsLoad(r) THEN r ELSE loading
    /\ flights' = IF NeedsLoad(r) THEN flights \cup {r} ELSE flights
    /\ duplicateLoad' = (duplicateLoad \/ (NeedsLoad(r) /\ (done = r \/ loading = r)))
    /\ image' = image
    /\ replacementLost' = (replacementLost \/ (image # 0 /\ image' # image))
    /\ UNCHANGED <<done, stalePublished>>

Forget ==
    /\ listed' = 0 /\ loading' = 0 /\ done' = 0 /\ image' = 0
    /\ UNCHANGED <<flights, stalePublished, duplicateLoad, replacementLost>>

Finish(r, decodes) ==
    /\ r \in flights /\ listed = r /\ loading = r
    /\ loading' = 0 /\ done' = r
    /\ image' = IF decodes THEN r ELSE 0
    /\ flights' = flights \ {r}
    /\ stalePublished' = (stalePublished \/ listed # r \/ loading # r)
    /\ UNCHANGED <<listed, duplicateLoad, replacementLost>>

Drop(r) ==
    /\ r \in flights /\ (listed # r \/ loading # r)
    /\ flights' = flights \ {r}
    /\ UNCHANGED <<listed, loading, done, image, stalePublished, duplicateLoad, replacementLost>>

Abandon(r) ==
    /\ r \in flights
    /\ flights' = flights \ {r}
    /\ loading' = IF loading = r THEN 0 ELSE loading
    /\ UNCHANGED <<listed, done, image, stalePublished, duplicateLoad, replacementLost>>

Next ==
    \/ \E r \in Revisions : Update(r) \/ Drop(r) \/ Abandon(r)
    \/ \E r \in Revisions, decodes \in BOOLEAN : Finish(r, decodes)
    \/ Forget
    \/ UNCHANGED vars

TypeOK ==
    /\ listed \in Values /\ loading \in Values /\ done \in Values /\ image \in Values
    /\ flights \subseteq Revisions
    /\ stalePublished \in BOOLEAN /\ duplicateLoad \in BOOLEAN /\ replacementLost \in BOOLEAN
DeletedStaysEmpty == listed = 0 => image = 0
OnlyWantedRevisionPublishes == ~stalePublished
NoRedundantLoad == ~duplicateLoad
ReplacementKeepsImage == ~replacementLost
====

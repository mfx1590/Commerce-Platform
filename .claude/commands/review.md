Act as the REVIEWER for PR $ARGUMENTS. Do not write code. Read docs/ownership.md and the linked issue, then the diff.
Check: files inside the owning branch's allowed paths; acceptance criteria met; tests exist and pass; memory file updated; no secrets, no RLS bypass, no direct bus publish, no contract/event/db-schema edits unless branch is main/* or integration/*.
Reply with exactly "MERGE" or "BLOCK" followed by numbered reasons.

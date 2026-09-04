---
type: regex
pattern: "(?is)((customs cleared|destination\\.customs\\.cleared).{0,80}(2024-01-25|25 Jan|Jan 25)|(2024-01-25|25 Jan|Jan 25).{0,80}(customs cleared|destination\\.customs\\.cleared))"
match: contains
target: last_message
---
Must include the Import Customs Cleared milestone on 2024-01-25 with a human label or code.

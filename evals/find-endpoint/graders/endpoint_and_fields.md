---
type: regex
pattern: "(?s)(hub/tag/create|api/app/tag).*organizationUnitId"
match: contains
target: last_message
---
Must name hub/tag/create (POST api/app/tag) and the organizationUnitId body field.

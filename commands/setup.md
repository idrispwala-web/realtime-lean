---
name: setup
description: Store your personal realtime API key for the realtime-lean plugin and verify the connection
---

Set up the realtime-lean connector for this user. Arguments: `$ARGUMENTS` (the API key, optional).

1. If `$ARGUMENTS` is empty, tell the user: create a key at https://admin.mcp.cargonerds.dev/api-keys (API Key Administration, New API Key) and run `/realtime-lean:setup <key>`. Stop.
2. Otherwise write the key, trimmed, to the file `~/.realtime-lean/key` (create the directory; on Windows `~` is `%USERPROFILE%`). Overwrite if present. Do not echo the key back.
3. Call the `rt_query` tool from the realtime server with `entitySet: Shipment`, `select: id`, `top: 0`, `count: true`. The connector reads the key file on every call, so no restart is needed.
4. Report: "realtime-lean ready, N shipments visible to this key" on success, or the error text on failure (a 401 means the key is wrong or revoked).

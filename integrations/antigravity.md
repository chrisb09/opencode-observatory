# Exact Antigravity account attribution

Lifecycle collection and inference HTTP attempts work without this bridge when session headers survive the auth plugin's transformation. Opaque Google access tokens do not expose a stable account identity. Do not infer the selected account from `activeIndex` on disk: concurrent requests and retries can use different accounts.

The collector installs a process-local callback. In the auth plugin, immediately before the **actual inference fetch** using the selected account, call:

```ts
const bridge = (globalThis as any)[Symbol.for("opencode.observatory.account.v1")]
bridge?.(account.access, account.email ?? account.parts?.refreshToken ?? String(account.index))
const response = await fetch(prepared.request, prepared.init)
```

Use the actual access token in `prepared.init.headers` if it differs from `account.access`. The bridge retains the mapping only in process memory. Only an HMAC of the stable account identity is uploaded; neither access nor refresh tokens are queued. Apply this at every account-specific inference path, including fallbacks. Rebuild that plugin and restart OpenCode.

The local sibling `../opencode-antigravity-auth` now includes this optional bridge in `src/plugin/observatory.ts`, called after request preparation and before the selected-account inference/warmup paths. It extracts the actual bearer from the prepared headers and uses the selected account email or refresh identity only in process memory. Public API-key fallbacks are identified from their `x-goog-api-key` instead. The auth plugin has been rebuilt; quit and restart OpenCode to load it.

Tests exercise three selected accounts, absent/failing callbacks, and Observatory lifecycle attribution after retries. Live paid Antigravity authentication is not exercised by automated tests. If you use a different auth-plugin checkout or update it, retain/reapply this small integration. Past sessions cannot be retrospectively split into accounts that OpenCode never recorded.

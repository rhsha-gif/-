# Domain and Origin Hygiene

Create a canonical map before changing networking code:

```text
Frontend origin:
Backend/API origin:
WebSocket origin, if any:
Auth/callback origin, if any:
Storage provider origin, if any:
Preview/staging origin, if any:
Production origin:
```

Search for `localhost`, `127.0.0.1`, absolute HTTP/WebSocket URLs, common dev ports, and known deployment domains. Classify each occurrence as central config, docs/example, test fixture, or bug.

## Rules

- Preserve the repository's canonical loopback host. Do not mix `localhost` and `127.0.0.1` without a documented reason.
- Centralize browser-visible and server-only URLs in existing config modules and environment variables.
- Use `VITE_*` or `NEXT_PUBLIC_*` only for values the browser must read. Never expose secrets through them.
- Keep `.env.example` synchronized with variable additions and renames, using local defaults and no real secrets.
- For credentialed CORS, use an explicit environment-backed allowlist rather than `*`.
- In local HTTP development, usually omit a cookie domain and disable `secure`; production cookies normally require `secure`. Verify `sameSite` against the actual cross-site flow.
- Generate OAuth, magic-link, and reset callbacks from one canonical public origin.
- Apply the same centralization policy to WebSocket and SSE endpoints.

Run the scanner when a repository-wide audit is useful:

```powershell
python "$env:USERPROFILE\.agents\skills\local-dev-runbook\scripts\audit_domains.py" `
  "C:\path\repo" --domain example.vercel.app
```

Treat scanner matches as candidates, not automatic defects. Finish with the project's checks plus browser/network verification of the canonical frontend URL, API health, auth callback, CORS behavior, and session persistence.

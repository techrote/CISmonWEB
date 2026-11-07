# Security notes

CISmonWEB handles a GitHub credential. The local-web architecture improves several properties of the ESP32 proof of concept, but it still requires explicit handling.

## Use a least-privilege token

Use a fine-grained GitHub token with read-only access and only to repositories CISmonWEB should monitor.

Do not use an Actions write token, administration token, or a broad classic PAT when narrower access is possible.

## The browser does not receive the token

The token is submitted to the local configuration endpoint and retained by the Node process.

GET /api/config returns only a boolean indicating whether a token exists. Dashboard/state endpoints never include it.

When GITHUB_TOKEN is supplied through the environment, it overrides the stored token for that process.

Environment overrides and stored settings are separate. Saving a surface or
other setting does not copy `GITHUB_TOKEN` to disk. Saving or clearing a stored
token does not disable an environment token. Configure reports the effective
token source and whether a separate stored token exists, without returning
either credential.

Earlier versions could copy an environment token into `config.json` on a
settings save. An existing stored token is not silently deleted, because the
app cannot distinguish that copy from an intentionally stored credential. If
using an environment token exclusively, use **Remove the stored GitHub token** and Save;
the environment credential remains active.

## Local storage

The default data directory is ~/.cismonweb.

The configuration file is written with mode 0600 and the directory is created with mode 0700 where supported.

Configuration updates are serialized. A save writes and flushes a unique
temporary file in the same directory, closes it, and replaces `config.json`
before publishing the new in-memory settings. Failed saves preserve the last
accepted settings and clean up their temporary files. Run one server process
per data directory; this queue does not coordinate independent processes.

This is not a hardware-backed secret store. A user or process that can read the account's files should be assumed capable of recovering the stored token.

For higher-assurance use, provide the token as an environment variable from an operating-system secret manager instead of saving it through the UI.

## Network exposure

The default HTTP listener is 127.0.0.1:8787.

This is intentional because the configuration endpoint has no login layer.

Changing CISMON_HOST to a non-loopback address can expose configuration mutation to other hosts. Do not do that on an untrusted network without adding authentication and transport protection in front of CISmonWEB.

The listener validates HTTP `Host` against its configured bind host/address,
the socket's local address and loopback aliases. API requests carrying a foreign
`Origin` or cross-origin Fetch Metadata are rejected. These checks protect the
local browser boundary against DNS rebinding and cross-site requests; they do
not authenticate another local process or an explicitly admitted network peer.

API writes require `Content-Type: application/json`. Malformed UTF-8/JSON and
non-object bodies return 400, bodies over 262,144 bytes return 413, and other
media types return 415. For example, a command-line refresh uses:

```sh
curl -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:8787/api/refresh
```

Reverse proxies must present a trusted upstream `Host` and matching `Origin`.
Forwarded host/protocol headers are not automatically trusted. A proxy that
terminates TLS or rewrites hostnames must normalize its upstream authority and
origin consistently, while retaining its own authentication boundary.

## Browser hardening

The local server sends a restrictive Content Security Policy and denies framing.

The UI uses text nodes for dynamic repository/workflow/job content rather than injecting GitHub-provided strings as HTML.

External GitHub links use a new browsing context with noreferrer.

## Data minimization

The timing journal stores duration metadata only. It does not ingest workflow logs, source files, commit contents, or secret values.

A future logging/diagnostics layer should retain this rule and include explicit token-redaction tests.

# Security notes

CISmonWEB handles a GitHub credential. The local-web architecture improves several properties of the ESP32 proof of concept, but it still requires explicit handling.

## Use a least-privilege token

Use a fine-grained GitHub token with read-only access and only to repositories CISmonWEB should monitor.

Do not use an Actions write token, administration token, or a broad classic PAT when narrower access is possible.

## The browser does not receive the token

The token is submitted to the local configuration endpoint and retained by the Node process.

GET /api/config returns only a boolean indicating whether a token exists. Dashboard/state endpoints never include it.

When GITHUB_TOKEN is supplied through the environment, it overrides the stored token for that process.

## Local storage

The default data directory is ~/.cismonweb.

The configuration file is written with mode 0600 and the directory is created with mode 0700 where supported.

This is not a hardware-backed secret store. A user or process that can read the account's files should be assumed capable of recovering the stored token.

For higher-assurance use, provide the token as an environment variable from an operating-system secret manager instead of saving it through the UI.

## Network exposure

The default HTTP listener is 127.0.0.1:8787.

This is intentional because the configuration endpoint has no login layer.

Changing CISMON_HOST to a non-loopback address can expose configuration mutation to other hosts. Do not do that on an untrusted network without adding authentication and transport protection in front of CISmonWEB.

## Browser hardening

The local server sends a restrictive Content Security Policy and denies framing.

The UI uses text nodes for dynamic repository/workflow/job content rather than injecting GitHub-provided strings as HTML.

External GitHub links use a new browsing context with noreferrer.

## Data minimization

The timing journal stores duration metadata only. It does not ingest workflow logs, source files, commit contents, or secret values.

A future logging/diagnostics layer should retain this rule and include explicit token-redaction tests.

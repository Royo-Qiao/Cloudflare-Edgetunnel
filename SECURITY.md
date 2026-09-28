# Security Policy

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via GitHub's
[private vulnerability reporting](https://github.com/Royo-Qiao/Cloudflare-Edgetunnel/security/advisories/new)
on this repository — this reaches the maintainer directly with no public
disclosure. If you prefer, you may also contact the maintainer through their
GitHub profile (https://github.com/Royo-Qiao) to coordinate another private
channel.

When reporting, please include:

- the wizard step, CLI flag, or endpoint affected
- reproduction steps and expected vs. actual behavior
- your assessment of the impact

You may request credit and an embargo period; we will acknowledge reports as
soon as possible.

## Scope

Of particular interest: the Cloudflare API token handling in `lib/deploy.mjs`
and the local Express server (`server.mjs`) — e.g. token leakage, SSRF, or
credential exposure in the deploy flow.

Issues in the deployed `_worker.js` (fetched from upstream
[cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)) should be reported
upstream; this repository does not modify the worker code.

# Contributing to Cloudflare-Edgetunnel

Thanks for taking the time to contribute! :sparkles:

## Development Setup

Requirements: Node.js ≥ 22 (the lockfile-pinned wrangler declares `engines: node >=22.0.0`)

```bash
git clone https://github.com/Royo-Qiao/Cloudflare-Edgetunnel.git
cd Cloudflare-Edgetunnel
npm install
npm run dev   # starts the local server with auto-reload on file changes
```

Open `http://localhost:3000`.

## Project Layout

- `server.mjs` — local Express server exposing the Web wizard (`/api/*`)
- `web/` — wizard frontend
- `admin-ui/` — self-hosted admin pages deployed alongside the worker
- `lib/` — Cloudflare API helpers, config, IP optimization, deploy logic
- `scripts/deploy-cli.mjs` — headless CLI deployment

## Reporting Issues

Please include:

- reproduction steps and expected vs. actual behavior
- Node.js version and OS
- the wizard step (or CLI flags) where things went wrong

Do **not** open public issues for security vulnerabilities — report privately
via [SECURITY.md](SECURITY.md) (GitHub private vulnerability reporting).

## Pull Requests

1. Create your branch from `main`.
2. Keep changes focused — one concern per PR.
3. Update `README.md` if behavior, flags, or commands change.
4. Verify `npm run dev` starts cleanly before submitting.
5. By participating, you agree to the [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

By contributing, you agree that your contributions will be licensed under the
MIT License (files under `admin-ui/` remain subject to GPL-2.0 — see
[NOTICE.md](NOTICE.md)).

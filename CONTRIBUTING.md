# Contributing to Cloudflare-Edgetunnel

Thanks for taking the time to contribute! :sparkles:

## Development Setup

Requirements: Node.js ≥ 18

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

Do **not** open public issues for security vulnerabilities — contact the
maintainer privately (e.g. via the email on their GitHub profile).

## Pull Requests

1. Create your branch from `main`.
2. Keep changes focused — one concern per PR.
3. Update `README.md` if behavior, flags, or commands change.
4. Verify `npm start` runs cleanly before submitting.

By contributing, you agree that your contributions will be licensed under the
MIT License.

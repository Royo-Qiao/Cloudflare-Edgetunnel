# Deploy edgetunnel to Cloudflare Pages from a local web wizard

Cloudflare-Edgetunnel is a Node.js web wizard and CLI for deploying
[cmliu/edgetunnel](https://github.com/cmliu/edgetunnel). It creates/configures
Pages, KV and a custom domain, then provides a Clash subscription URL. The node
implementation remains the upstream project's code; see [NOTICE.md](../NOTICE.md)
for the MIT/GPL-2.0 split and upstream attribution.

## Prerequisites

- Node.js 22 or newer, as declared by [package.json](../package.json).
- A domain already hosted on Cloudflare with an Active zone.
- A Cloudflare API token with the permissions listed in the main
  [setup instructions](../README.md#前置准备). Use resources you control.

## Quickstart

```sh
git clone https://github.com/Royo-Qiao/Cloudflare-Edgetunnel.git
cd Cloudflare-Edgetunnel
npm install
npm start
```

Open `http://localhost:3000` and follow authentication, domain/UUID configuration,
deployment, IP selection and subscription generation. Starting the local web
server alone does not deploy a node or validate a proxy connection. After
deployment, check the Pages custom-domain status and test the subscription in
your client.

For the CLI, use the `--name=value` argument format:

```sh
CF_API_TOKEN=your-token node scripts/deploy-cli.mjs --zone=example.com --subdomain=cloudflare-edgetunnel
```

The CLI requires `--zone`. `--subdomain` defaults to `cloudflare-edgetunnel`,
`--uuid` supplies an existing UUID, and `--optimize` runs the TLS-latency selection
step after deployment. These documented commands map to the repository's scripts;
they are not a report of a deployment performed during this documentation review.

## How is an IP selected?

The web and CLI paths test TLS connection latency with the node hostname as SNI,
rank reachable candidate addresses, and write up to 30 results to KV `ADD.txt`.
The selection also disables the random-IP setting in `config.json`. This is not
a download-throughput test or proof of an end-to-end proxy connection.

## How do I preserve an existing subscription?

The CLI generates a new UUID when `--uuid` is omitted. Supply your original UUID
when redeploying an existing node. The web wizard attempts to read the current
UUID; an uncertain lookup should be resolved before deployment.

Resource names use the subdomain label: `edt-pages-<label>` and `edt-kv-<label>`.
Changing the label selects different resources. Reusing the same label under a
different root domain in the same account must not be assumed to isolate resources.

## What if deployment reports a network error?

Confirm that the local machine can reach `api.cloudflare.com`. The deployment
code reads existing proxy environment variables and, for network errors, can
alternate direct and configured-proxy attempts. It does not make business/API
errors disappear. See the [Chinese troubleshooting notes](../README.md#常见踩坑)
for the detailed behavior and redeployment checks.

## Contributing and licensing

Use [CONTRIBUTING.md](../CONTRIBUTING.md) for the development entry point and
[SECURITY.md](../SECURITY.md) for sensitive reports. Do not include real API tokens,
UUID passwords or private subscription URLs in public issues.

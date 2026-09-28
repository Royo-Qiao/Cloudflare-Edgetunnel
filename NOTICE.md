# NOTICE

This file records third-party provenance and the license split of this
repository. It must accompany any redistribution.

## `admin-ui/` — GPL-2.0 derived code

The `admin-ui/` directory is derived from the admin interface of
[edt-pages/EDT-Pages.github.io](https://github.com/edt-pages/EDT-Pages.github.io)
(`admin-ui/index.html` documents this fork origin). The upstream code belongs
to the edgetunnel ecosystem, whose LICENSE is the GNU General Public License
v2.0 (see [cmliu/edgetunnel LICENSE](https://github.com/cmliu/edgetunnel)).

Accordingly, the `admin-ui/` directory in this repository remains licensed
under the **GNU GPL-2.0**, with copyright belonging to the upstream authors.
It is **not** covered by the MIT license that applies to the rest of this
repository.

## `_worker.js` — fetched from upstream at deploy time

The proxy worker (`_worker.js`) is not stored in this repository; every
deployment fetches the latest version from
[cmliu/edgetunnel](https://github.com/cmliu/edgetunnel). That project is
copyright its authors and distributed under the GNU GPL-2.0. All credit for
the VLESS proxy implementation belongs to its authors.

## Everything else — MIT

All other files (Web wizard `web/`, `lib/`, `scripts/`, `server.mjs`,
documentation) are Copyright (c) 2026 Cloudflare-Edgetunnel contributors and
released under the MIT License (see [LICENSE](LICENSE)).

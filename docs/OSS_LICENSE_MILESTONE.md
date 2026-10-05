# OSS license milestone: MIT for Perch, dependency license review, third-party notices

As of 2026-10-05, branch `feat/perch-oss-license` (based on `ad12f1e`, the email milestone).

**Approval:** Fritz approved a permissive OSS license (MIT preferred) **only after** a dependency compatibility and notice review (`docs/PROJECT_SCOPE.md`, "Delivery model"). This document is that review. Its result supports MIT, and Perch's own source is now MIT-licensed.

**Not changed:**
- `package.json` keeps `"private": true`, so nothing is published to npm.
- Repository visibility is unchanged.
- Nothing was committed, pushed, merged or deployed by this run.

This is an engineering review of license metadata and texts. It is **not legal advice** and was not reviewed by a lawyer.

## 1. Decision

| Item | Result |
| --- | --- |
| Perch license | **MIT**: `LICENSE` contains the SPDX `MIT` template text with `Copyright (c) 2026 Fritz Kuermayr`. `package.json` and the `package-lock.json` root entry say `"license": "MIT"` (was `UNLICENSED`) |
| Copyright holder | `Fritz Kuermayr`: `git config user.name` in this worktree. All 3 commits up to `ad12f1e` are authored by Fritz Kuermayr (one co-authored by Claude) |
| Third-party code in Perch's tree | none found: no copied code or license headers in `src/` or `test/`. `dist/` is plain `tsc` output of `src/` (target ES2022), with no inlined helpers (`__awaiter`, `tslib`, …) and no third-party headers |
| Third-party rights | dependencies are **not relicensed**. `THIRD_PARTY_NOTICES.md` reproduces their license/notice texts verbatim, plus the reviewed attribution text embedded in their code that the scan found (§5 limits) |
| `package.json` description | updated from the obsolete "Read-only multi-account Google Drive + multi-workspace Notion MCP server" to the implemented scope (Drive/Notion read-only plus Gmail/Graph/IMAP-SMTP mail with per-client draft/send grants) |
| `package.json` files | `dist`, `THIRD_PARTY_NOTICES.md` (npm adds `LICENSE` automatically). Only relevant if a tarball is ever packed; publishing is not authorised |

**Why MIT is compatible:**
- Every **package license** in the production closure (SPDX id from package metadata, checked against the bundled license file) is on the allowlist: MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause, plus MIT elected from one `MIT OR EUPL-1.1+` dual license.
- **Embedded grants are a separate inventory.** The allowlist only covers package licenses. One reviewed embedded grant has **no SPDX identifier**: the Masanao Izumo Base64 header in `encoding-japanese` ("This library is free.  You can redistribute it and/or modify it.", §4 item 5). It reads as permissive and states no condition. It is reproduced anyway and labelled "Non-SPDX grant" in the notices. It is **not** claimed to be on the SPDX allowlist.
- No copyleft license text and no Apache-2.0 `NOTICE` file was found in the production closure, within the limits of the scan (§5).

**Obligations that remain:**
- Retain the copyright and permission notices when the dependencies are redistributed (done by `THIRD_PARTY_NOTICES.md`).
- BSD-3-Clause no-endorsement (`fast-uri`, `qs`): Perch makes no such endorsement claims.

**What Perch distributes today:**
- The source repository and `package-lock.json`. `npm ci` fetches the dependencies from the npm registry.
- The notices file covers the production closure exactly as `npm ci --omit=dev` installs it. That is the set a future container image or bundled tarball would redistribute.

## 2. Primary sources checked (2026-10-05)

- **SPDX License List 3.29.0** (released 2026-09-16), from `https://spdx.org/licenses/licenses.json`:
  - `MIT`, `MIT-0`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `EUPL-1.1`, `EUPL-1.2`, `Apache-2.0` and `MPL-2.0` are all listed, OSI-approved and not deprecated.
- **Official MIT text** (`https://spdx.org/licenses/MIT.json`, `licenseText`): `LICENSE` equals it after whitespace normalisation, with `<year> <copyright holders>` = `2026 Fritz Kuermayr` (checked programmatically).
- **Official MIT-0 text** (`https://spdx.org/licenses/MIT-0.json`): used to check the `imapflow`/`nodemailer` texts (§4).
- **npm registry** (`npm view <pkg>@<version> license repository.url gitHead dist.integrity`): `imapflow@2.2.5` MIT, `nodemailer@10.0.14` MIT-0, `@zone-eu/mailsplit@5.4.20` `(MIT OR EUPL-1.1+)`, `@modelcontextprotocol/sdk@1.32.0` MIT, `zod@4.6.5` MIT. The integrities match `package-lock.json`.
- **Upstream repository:** `postalsys/imapflow` at the published `gitHead` `ca0fb63763b10091735721ae415184f2b4416108`. Its `LICENSE.txt` has the same truncated text as the tarball, and its `package.json` says `"license": "MIT"`.
- **Installed packages:** a clean `npm ci` (and separately `npm ci --omit=dev`) on Node 26.7.0 / npm 11.19.0, linux-x64. For every production package, the license file, manifest and code were read from `node_modules`.

## 3. Inventory (from `package-lock.json`, lockfileVersion 3)

| | Count |
| --- | --- |
| Lockfile package entries (excluding root) | 185 |
| Direct production dependencies | 4: `@modelcontextprotocol/sdk` 1.32.0, `imapflow` 2.2.5, `nodemailer` 10.0.14, `zod` 4.6.5 |
| Production closure (direct + transitive) | **115 package versions** in **117 installed locations**, 113 distinct names. `content-type` 1.0.5 + 2.1.0 (2.1.0 nested 3×) and `real-require` 0.2.0 + 1.0.0 |
| Production licenses applied | **MIT 103** (102 declared MIT + `@zone-eu/mailsplit` elected MIT), **ISC 8**, **BSD-3-Clause 2** (`fast-uri`, `qs`), **BSD-2-Clause 1** (`json-schema-typed`), **MIT-0 1** (`nodemailer`) |
| Production packages without a bundled license file | 0 |
| Production lockfile/manifest version or license mismatches | 0 |
| Nested `NOTICE`/`COPYING`/`AUTHORS`/third-party license files in production packages | 0 |
| Embedded attribution blocks reviewed | 17 in 8 packages: 13 reproduced (2 of them carry the non-SPDX Izumo grant), 4 covered by the package's own license file (§4) |
| License texts needing a reviewed override | 4: `imapflow`, `nodemailer` (MIT-truncated), `encoding-japanese` (MIT+extra), `fast-uri` (UNKNOWN: reworded clause 3) |
| Direct dev dependencies | 6: `@types/node`, `@types/nodemailer`, `@types/smtp-server`, `smtp-server`, `typescript`, `vitest` |
| Development inventory | **68 package versions** (lockfile). 43 installed on linux-x64; 25 platform-specific optional binaries (`@rolldown/binding-*`, `lightningcss-*`, `fsevents`) not installed here |
| Development licenses (lockfile metadata) | MIT 50, MPL-2.0 12, Apache-2.0 3, BSD-3-Clause 1, ISC 1, MIT-0 1 |

The production closure from `scripts/licenses.mjs` is cross-checked in the test suite against npm's own resolver (`npm query .prod`): the same 117 locations and name@version pairs.

## 4. Review findings

**Production:**

1. **`@zone-eu/mailsplit@5.4.20`** (via `imapflow`) declares `(MIT OR EUPL-1.1+)` and bundles `LICENSE.MIT` and `LICENSE.EUPL-1.2`. README: "Dual licensed under **MIT** or **EUPLv1.1+**".
   - Perch **elects MIT**, and only `LICENSE.MIT` is reproduced.
   - Without this explicit, reviewed election the check fails, because EUPL is not on the production allowlist.
2. **`imapflow@2.2.5`** declares MIT, but `LICENSE.txt` is **neither SPDX MIT nor SPDX MIT-0**.
   - It ends the grant with "subject to the following conditions:" and then states no condition. The upstream repository at the published gitHead has the same text.
   - The check classifies the text as `MIT-truncated`. A reviewed override treats it **conservatively as MIT**, so the notice is retained.
3. **`nodemailer@10.0.14`** declares MIT-0 (CHANGELOG: "was defined as MIT, actual value MIT-0"), but its `LICENSE` has the same truncated shape.
   - It also **vendors `punycode.js` (Mathias Bynens) under the full MIT license** (`dist/cjs/punycode/index.js`, `dist/esm/punycode/index.js`), which requires retaining that notice.
   - So "nodemailer is MIT-0, no attribution needed" would be **wrong**. Both the nodemailer notice and the punycode notice are reproduced.
4. **Other embedded attribution in shipped code**, reproduced and sha256-pinned:
   - `hono`: a goober-derived hash (MIT, Cristian Bote; cjs and esm builds) and JSX types based on React (MIT, Meta Platforms).
   - `iconv-lite`: type declarations, Copyright Microsoft Corporation, MIT.
   - `encoding-japanese`: typings derived from DefinitelyTyped, MIT.
   - `fast-uri`: the test file `test/uri-js.test.js` carries Gary Court's own BSD text with an extra paragraph.
5. **`encoding-japanese@2.4.0` vendors Masanao Izumo's Base64 code** (found after the independent review; the old phrase scan missed it because the header has no license marker, only `Copyright`).
   - `src/util.js` lines 229-236 and `encoding.js` lines 6124-6131 (the browserify build) are byte-identical. Upstream text: `/* Copyright (C) 1999 Masanao Izumo <iz@onicos.co.jp>`, `Version: 1.0`, `LastModified: Dec 25 1999`, `This library is free.  You can redistribute it and/or modify it.`, `// -- Masanao Izumo Copyright 1999 "free"`.
   - `encoding.min.js` contains the minified Base64 functions (`base64encode`/`base64decode`). Its only comment is the polygonplanet banner; uglify dropped the Izumo header. The reproduced notice also stands for that build.
   - The package `LICENSE` (polygonplanet MIT plus a "Third-Party Licenses and Credits" section for DefinitelyTyped/Microsoft) does not mention Izumo.
   - Both locations are reproduced and sha256-pinned. The grant is recorded verbatim as `nonSpdxGrant`; the check fails if that sentence is not in the pinned excerpt. It has no SPDX identifier, so it is outside the SPDX allowlist check. On its face it states no attribution condition. Reproducing it is the conservative choice, not a legal conclusion.
6. **Further bare copyright lines** found by the same scan extension, all reproduced:
   - `negotiator@1.1.0` `lib/accept.js` 1-5: `Copyright(c) 2026 Blake Embrey`, "MIT Licensed". The package LICENSE does not name this holder.
   - `hono@4.13.13` `dist/types/utils/types.d.ts` 43-46: `@copyright from sindresorhus/type-fest`, with no license text. type-fest is not in Perch's tree. The license of the revision hono copied from was not verified.
   - `split2@4.2.0` `index.js` 1-15: its own ISC text, but with year range 2014-2021 (LICENSE: 2014-2018).
7. **License texts with extra or reworded material** (found by the stricter text matching, §5), each with a reviewed override:
   - `encoding-japanese` `LICENSE`: the full MIT text plus the credits section (`MIT+extra`). No additional restriction found.
   - `fast-uri` `LICENSE`: clause 3 reads "The names of any contributors may not be used to endorse or promote…" instead of the SPDX wording, and a contributors URL follows (`UNKNOWN`). No additional restriction found. Treated as the declared BSD-3-Clause.
8. **Covered, not reproduced twice:**
   - The three `json-schema-typed` draft headers: their BSD-2-Clause body and IETF Trust/author copyright lines appear verbatim in its `LICENSE.md`, which is reproduced.
   - `encoding-japanese/src/banner.js`: a build template with placeholders for the package's own metadata.
9. **`pkce-challenge@5.0.1`** (via the MCP SDK): the MIT `LICENSE` names no holder (`Copyright (c) 2019 ` with nothing after it), both in the tarball and upstream (`crouchcd/pkce-challenge`, `master`).
   - It is reproduced as shipped. `package.json` names the author `crouchcd`. No holder was invented.
10. **`@modelcontextprotocol/sdk@1.32.0`**: MIT, `Copyright (c) 2024 Anthropic, PBC`.
11. **Not detected automatically:** copied code without any marker or copyright line, and copyright lines whose holder is (also) named in the package's own license file. The scan is a heuristic, not copied-code detection (§5).

**Development (not distributed):**

- **MPL-2.0:** `lightningcss` 1.33.0 and its 11 platform binaries, a transitive dependency of the vite/vitest test toolchain.
- **Apache-2.0:** `typescript` 5.9.3, `detect-libc` 2.1.2, `expect-type` 1.4.0.
- None of them is part of `npm ci --omit=dev` or of `dist/`. They are inventoried in `licenses/DEV_DEPENDENCIES.md`, and their license texts are not reproduced.
- `ipv6-normalize@1.0.1` (dev-only, via `smtp-server`) declares MIT but ships no license file. This is recorded here only; it would block if it ever became a production dependency.

## 5. The check (`scripts/licenses.mjs`, Node built-ins only, no new dependencies)

```bash
npm ci                       # or npm ci --omit=dev; both pass
npm run licenses:check       # verify policy + that generated files match the lockfile closure (CI step)
npm run licenses:generate    # rewrite THIRD_PARTY_NOTICES.md and licenses/DEV_DEPENDENCIES.md (refuses on policy errors)
```

**Files:**
- `licenses/policy.json` (reviewed input):
  - allowlists: production MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause; development additionally Apache-2.0, MPL-2.0;
  - the mailsplit election;
  - 4 reviewed text overrides (imapflow, nodemailer, encoding-japanese, fast-uri);
  - 17 embedded-text entries pinned by package@version, file, line range and sha256. An entry may record a `nonSpdxGrant` (verbatim sentence; must occur in the pinned excerpt).
- `THIRD_PARTY_NOTICES.md` (generated). Per production package it lists:
  - version, applied SPDX, source URL, registry tarball, lockfile integrity and installed paths;
  - the verbatim license/notice files;
  - the reviewed embedded excerpts, with any non-SPDX grant labelled separately, plus a summary count of such grants.
- `licenses/DEV_DEPENDENCIES.md` (generated): the dev inventory, from the lockfile only, so it is platform independent.

**Fail-closed rules.** Each of the following makes the check exit with code 1:
- **Lockfile:** lockfile older than v2; linked packages; a production entry not installed; installed name, version or license differing from the lockfile; lockfile `dev` flags contradicting the dependency graph (a production package requiring a dev-flagged one, or a non-dev entry unreachable from `dependencies`); an unresolvable required dependency.
- **License metadata:** missing or non-SPDX license metadata; a license outside the allowlist; an SPDX expression without a reviewed election, or electing a non-alternative or disallowed id; no bundled license file.
- **License text:** a license text whose classification differs from the declared or elected id without a matching reviewed override. The classifier compares the **whole body** (grant to end of disclaimer) against the SPDX template wording of MIT, MIT-0, ISC, BSD-2-Clause and BSD-3-Clause, plus the MIT-truncated shape:
  - Before the grant, only a title and copyright lines are accepted. Operative words there (`shall`, `must`, `only`, `commercial`, …) give UNKNOWN.
  - Extra material after a complete body gives `<id>+extra`, e.g. an appended Commons Clause.
  - Anything inserted into or changed in the body gives UNKNOWN, e.g. the JSON license's "Good, not Evil" or a BSD advertising clause.
  - Regression tests cover these three cases.
- **Embedded text** (fail closed on any of these):
  - a marker phrase in shipped code not covered by a pinned entry;
  - a copyright line (`Copyright`, `(c) <year>`, `© <year>`) whose holder is not named in the package's own reproduced license file;
  - a nested license-named file;
  - a symlink inside a production package;
  - a pinned excerpt whose sha256 changed;
  - a `nonSpdxGrant` not found in its excerpt;
  - a policy path escaping the package directory.
- **Policy and outputs:** stale policy entries (package version no longer in the closure); a missing source repository URL; generated files that differ from the regenerated output (drift).
- **Perch itself:** `package.json`/lockfile root license not `MIT`; `private` not `true`; `LICENSE` missing, not MIT, or without `Copyright (c) 2026 Fritz Kuermayr`.

Any dependency upgrade changes the closure. A changed version invalidates its pinned entries, so the check then demands a regenerated notices file and re-review.

**Limits (honest scope):**
- **The embedded scan is a heuristic, not fail-closed copied-code detection.**
  - It covers `.js/.mjs/.cjs/.ts/.mts/.cts/.jsx/.tsx` files and finds marker phrases plus copyright lines.
  - It does not find copied code that carries neither.
  - A copyright line counts as a self-reference, and is skipped, when its extracted holder is a substring of the package's reproduced license file. 103 lines in the current closure are skipped that way (mostly jshttp/express headers). A third-party holder who is also named in that file would be skipped too.
  - Not scanned: binaries (`.node`/`.wasm`), JSON, and source maps (`.map`; the closure ships 482 of them, and their `sourcesContent` can repeat comments).
- **Classification is a heuristic, not exact SPDX license matching.**
  - Holder names in the BSD/ISC disclaimers and the BSD-3 endorsement clause, and list markers, are wildcards (holder ≤120 characters).
  - Only the operative words above are rejected in the header.
  - Anything unrecognised is UNKNOWN and blocks. That is safe, but it may need a reviewed override after manual reading.
  - The safeguards are the manually reviewed texts, overrides pinned to package@version and file, and the drift check on the verbatim notices.
- Only top-level license files are classified. Nested ones must be reviewed via `embedded`.
- An optional *production* dependency that is not installed on the current platform would fail the check, since its license files cannot be read. There is none today.
- Rendering strips trailing whitespace per line, so the output passes `git diff --check`. Nothing else in the texts is changed.

## 6. TDD evidence (RED → GREEN)

Commands run in `~/perch-license-work` (Node 26.7.0, npm 11.19.0). Pure `LICENSE`, docs, policy data and config changes are exempt.

| # | Slice | RED (command → observed) | GREEN |
| --- | --- | --- | --- |
| 1 | License-text classifier, repository URL normalisation | `npx vitest run test/licenses.test.ts` → `Cannot find module '../scripts/licenses.mjs'` | 6/6 |
| 2 | Lockfile closure walk + installed-manifest verification | same → **8 failed** (`TypeError: collectInventory is not a function`) | 14/14 |
| 3 | Policy, elections, overrides, embedded scan, project metadata, rendering, drift, CLI exit codes | same → **18 failed** (`TypeError: runLicenses is not a function`) | 32/32 |
| 3b | Narrow "Copied from" marker to URLs (false positive in nodemailer `smtp-connection/index.d.ts:76`) | same → **3 failed** (`c@1.0.0: lib/self.js:6 unreviewed embedded license/notice text`) | 32/32 |
| 4 | Order by name, then version | same → **1 failed** (`ajv-formats` sorted before `ajv` via `name@version`). The real-repo check then failed with `THIRD_PARTY_NOTICES.md is out of date` until regenerated: drift detection on the real lockfile | 35/35 |
| 5 | Real repository: closure equals `npm query .prod`; policy check passes | proven by **mutation**: skipping nested `node_modules/*/node_modules/*` entries → **1 failed** (cross-check); restored → pass. Real-repo check before the review: **27 problems** with an empty policy (metadata, election, 2 truncated texts, 21 unreviewed embedded hits), then 3 (metadata), then 2 (outputs missing), then OK | 2/2 |
| 6 | Strip trailing whitespace in reproduced texts (`pkce-challenge` `Copyright (c) 2019 ` failed `git diff --check`) | same → **1 failed** (`expected … to contain 'Copyright (c) 2019\n'`) | 36/36 |
| 7 | Independent-review fixes: bare copyright lines (Izumo shape), non-SPDX grant label + pin, template matching (JSON "Good, not Evil", MIT + Commons Clause, BSD advertising clause, operative header), symlinks, policy path containment, real-repo Izumo reproduction (2026-10-05). First the ISC/BSD fixtures were switched to the full SPDX texts (36/36 still green) | same → **12 failed** of 49: `expected 'MIT' to be 'UNKNOWN'` ×2, `expected 'MIT' to be 'MIT+extra'`, `expected 'BSD-3-Clause' to be 'UNKNOWN'`, 6× missing error (`src/util.js:4 unreviewed`, `lib/isc.js:2`, `nonSpdxGrant … not found`, `reads as MIT+extra`, `is a symlink`, `escapes the package directory`), 1× generate errors, real repo `… to contain 'Embedded in src/util.js (lines 229-236)'`. The benign-variant test (jshttp quotes, named BSD holder) passed before and after. After implementing: the real-repo check reported **10 problems** (encoding-japanese MIT+extra, fast-uri UNKNOWN, Izumo 4 lines, hono type-fest, negotiator, split2 ×2), all reviewed and pinned (§4 items 5-7), then drift until regenerated, then OK | 49/49 |

### Final checks (2026-10-05)

| Check | Result |
| --- | --- |
| `rm -rf node_modules && npm ci --omit=dev && node scripts/licenses.mjs check` | OK: 115 production package versions (117 locations; MIT 103, ISC 8, BSD-3-Clause 2, BSD-2-Clause 1, MIT-0 1), 68 development entries |
| `rm -rf node_modules dist && npm ci && npm run licenses:check` | same OK line |
| `npm run check` (typecheck, `npm test`, build + smoke, `licenses:check`) | typecheck clean. **386/386** tests in 27 files (373 before the review fixes; 337/337 in 26 before this milestone; `test/licenses.test.ts` now 49). Smoke **5/5**. `licenses:check` OK |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `git diff --check` | clean |

CI (`.github/workflows/ci.yml`) runs `npm run licenses:check` after `npm ci` on Node 22.x and 24.x. `npm test` additionally runs the real-repository tests, which need `npm` on `PATH` for `npm query`.

## 7. Remaining scope

- **Docker/compose is not implemented:** there is no docker/podman/nerdctl/buildah runtime on this host, and no container was built.
  - Acceptance criterion for that milestone: the image must contain `LICENSE` and `THIRD_PARTY_NOTICES.md`.
  - The image must be built from `npm ci --omit=dev` of this lockfile, and `npm run licenses:check` must pass on that install.
  - Any OS base-image packages need their own notices. They are not covered here.
- **Not done:**
  - no npm publish (`private: true` stays);
  - no repository visibility change;
  - no commit/push/PR (orchestrator);
  - no lawyer review.
- **Review suggestions deliberately not implemented (documented instead):**
  - containment check on lockfile keys (local reviewed input);
  - asserting the full set of top-level files for elected packages (pinned to an exact version today);
  - schema validation of `policy.json` (a malformed file still exits non-zero, with a TypeError);
  - a separate CI job on `npm ci --omit=dev` (run locally, see §6; still required for the image milestone);
  - scanning source maps (§5 limits).
- **Upstream follow-ups (optional, not blocking):** ask `imapflow`/`nodemailer` to ship the exact SPDX text matching their declared id, and `pkce-challenge` to name its copyright holder.
- **Before every dependency upgrade:** run `npm run licenses:generate`, review the diff and any new failures, and update `licenses/policy.json` only after manual review.

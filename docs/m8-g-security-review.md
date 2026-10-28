# M8-G scanner recovery and security review

Latest assessment: M8-G7 supported-remediation feasibility review (2026-10-28) found no supported Trixie or official Node 24 update that resolves the five remaining distroless advisory IDs. No application, image pin or scanner policy is changed. The experimental image remains release-blocked; defer promotion. Earlier assessments and their execution evidence remain historical records below. M8-G overall is not complete.

Date: 2026-10-26. Scanner recovery and dependency patches are implemented. **Release acceptance remains blocked by current High/Critical findings.** No exception or production approval is granted. This assessment supersedes the earlier interrupted assessment, preserved verbatim in .security-reports/recovery-20261026-84116e8e-50b1-4b8b-b559-f9bd9fc99ec2/review-before-recovery.md. Original checkout triage and reports remain untouched.

## 1. Scanner preparation root cause

The old run-a99530b1-c273-4c37-9ff2-7ab1fc5e4608 failed before SBOM generation. It discarded command diagnostics, so its underlying operational cause cannot honestly be reconstructed. Current reproduction proves fixture installation/build and installed-package Syft cataloging work; it does not prove why the old attempt failed.

New diagnostics reproduced a 600-second Grype execution timeout (run-3c33d893-0c2e-443d-9a40-15e0707c8f60) and then isolated a 600-second cold database-provisioning timeout (run-586d0aef-7a99-4b31-8fda-1abb8c57f516). Download succeeded over verified HTTPS and extraction continued into a multi-gigabyte SQLite database. Neither failure was a vulnerability result. A separate real OCI missing-executable proof exposed a diagnostic-classification regex gap; the exact stat/exec error now has regression coverage. Its failed run-046394a2-b657-40cf-bdf4-02ae9eda31bf is preserved.

On this Windows x64 host, Docker Engine 29.1.3 runs Linux amd64 with four CPUs and about 5.57 GiB RAM. The pinned Syft/Grype executables run successfully. Database provisioning ultimately completed with exit 0; the measured successful proof update took about 1137 seconds. Resource/contention observations do not identify the lost original error or prove a single host-wide root cause.

## 2. Exact worktree and files changed

Worktree C:/Users/Administrator/OneDrive/Desktop/Github/BelovedDev-MCP-M8G; branch feat/m8-g-security; unchanged HEAD 2e56b7a2aa61fa7b8bfa8102335a8e87df8338e7. The full uncommitted change set includes preserved reconciliation work, not only this recovery's edits:

- .env.example
- .github/dependabot.yml
- .github/workflows/ci.yml
- .gitignore
- Dockerfile
- Dockerfile.trixie
- README.md
- apps/mcp-server/test/lifecycle.test.ts
- apps/mcp-server/test/main.test.ts
- docs/architecture.md
- docs/implementation-plan.md
- docs/local-stdio-container.md
- docs/m8-g-reconciliation-spec.md
- docs/m8-g-security-review.md
- docs/security.md
- package-lock.json
- package.json
- packages/application/package.json
- packages/database/package.json
- packages/infrastructure/package.json
- packages/infrastructure/src/environment.ts
- packages/infrastructure/src/logger.ts
- packages/infrastructure/src/signed-cursor.ts
- packages/infrastructure/src/signing-secret.ts
- packages/infrastructure/test/environment.test.ts
- packages/infrastructure/test/logger.test.ts
- packages/infrastructure/test/signed-cursor.test.ts
- packages/infrastructure/test/signing-secret.test.ts
- packages/mcp/package.json
- packages/mcp/src/server.ts
- packages/mcp/test/invocation-limits.integration.test.ts
- packages/mcp/test/server.test.ts
- packages/test-support/test/security-policy.test.ts
- scripts/container-smoke.ts
- scripts/security-check.ts
- security/grype.json
- security/toolchain.json
- tsconfig.check.json

No H1/H2 implementation, application rule, permission, tool schema or migration SQL changed. The no-emit check permits explicit .ts imports used by native Node 24 operational scripts; strictness and application emission remain unchanged.

## 3. Scanner repair and enforcement

Pinned scanner pulls, executable/version and Docker architecture checks precede cataloging. Each command records phase, sanitized arguments, exit/signal, elapsed time and bounded output. Missing executables, TLS/network, image/input/database errors, deadlines and validated vulnerability-policy failures remain distinct. Unknown exits on deadline are null, not invented scanner exits.

Scanner containers retain nonroot UID 1000, read-only filesystems, no capabilities/new privileges, memory/PID bounds and invocation-owned native cache volumes. They use two CPUs/2 GiB. Cold database provisioning has a separate finite 20-minute budget; matching/cataloging retain ten minutes. Every matching pass still requires successful update checking, hash-valid/current data (maximum age 120h), no future-dated metadata beyond five minutes, empty local suppressions/exclusions/VEX and High/Critical enforcement including unfixed findings. Explicit multiple-image comparisons share one provisioning context, not an unchecked cache.

The complete real proof passed (wrapper exit 0), run-ebc0c2cc-1edd-43dc-ac8f-e26582448c10:

| Case | Actual proof                                                     | Exit/result                                           |
| ---- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| A    | Pinned scanner image with genuinely missing executable           | Docker 127, executable failure                        |
| B    | Valid cached DB with network disabled and mandatory update check | Grype 1, database failure; cache cannot silently pass |
| C    | Genuinely absent local image                                     | Docker inspect 1, image failure                       |
| D    | Malformed SBOM                                                   | Grype 1, input failure                                |
| E    | Installed lodash 4.17.20 in scratch image, no lockfile           | Grype 2, parsed High/Critical findings; blocked       |
| F    | Installed is-number 7.0.0 in scratch image                       | Grype 0, parsed clean result                          |

The same run proves production/optional vulnerabilities block, development-only exclusion is scoped, full development audit blocks, missing locks and registry failures fail closed. All 13 proof flags are true. Both genuine fixture catalogs were subsequently accepted by the final config-hash/filesystem identity guard. Unit tests additionally reject stale/invalid/empty reports, ignored matches, false zero exits and diagnostic credential leaks.

## 4. Vite patch verification

A root override pins Vite 8.3.3. npm applied the compatible patch; the final lockfile changes installed versions only for Vite 8.3.2 to 8.3.3 and the preserved Zod 4.6.5 to 4.6.6 patch. Unrelated transitive upgrades were not retained. Clean npm ci with install scripts disabled passed. npm ls shows no duplicate old Vite/Zod or standalone launch-editor package; Vite's actual bundle identifies patched launch-editor 2.14.2. Both final Bookworm SBOMs exclude Vite/editor/development tools; inventory enforcement explicitly rejects their shipment.

References: [Vite advisory](https://github.com/advisories/GHSA-587h-7wmj-h5pm), [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). No forced audit fix or major upgrade ran.

## 5. Production dependency audit

npm audit --omit=dev: exit 0, zero vulnerabilities. The existing production security wrapper also exits 0 (run-7aac8f0d-6d0b-48a3-ad71-ce6a2fe20b7c). Strict TLS and optional/peer production coverage remain. Evidence: production.audit.json in the recovery directory.

## 6. Full dependency audit

npm audit: exit 0, zero vulnerabilities, including development dependencies. CI now also runs the full-tree audit rather than relying on a production-only pass. Evidence: full.audit.json. This clears the known Vite advisory without declaring all development workflows inherently safe.

## 7. SBOM generation and immutable identities

Syft JSON catalogs the entire saved final image, including OS and actually installed npm packages. Runtime SDK/Zod/pg inventory is mandatory, not inferred from a lockfile. The two Bookworm inventories contain 131 artifacts and Debian 12.15 metadata. The complete Trixie final archive catalogs 122 artifacts on Debian 13.7; it is a full release filesystem, not a base-only scan.

| Artifact               | Immutable identity / archive SHA256                                     |
| ---------------------- | ----------------------------------------------------------------------- |
| Original main image    | sha256:e4d597ecc9d4f4d64d273a4f8828c75cf488ec779e336fbbf0001650ff6140a6 |
| Original saved archive | cc86e58975df93f2bbdb7b61b5e8c0dc52ca0837c8c898175db33ca0492e5c6d        |
| Patched Bookworm image | sha256:987565e42e09f98fa57ee7428d527083180b44825628562dce9ae568706005c5 |
| Patched saved archive  | 19ec56690741bcf3a955bfc1e894fd1e1b9d81d6bc172c07cd6c541196f4de2f        |

Evidence: run-4c33d8bf-c7e8-4d07-9aff-d32af7f0b829/release-{1,2}.{sbom.json,identity.json,tar,vulnerabilities.json,exit.json}. Archive hashes identify these local exports; they are not invented registry RepoDigests. Docker save normalizes the OCI config: original/patched archive config digests are sha256:b34ed1ac8941ccdbf306cbe3e50378ea737901b436467efef49a0d67289867b1 and sha256:bc44db3171eb759706b9ae0ce8c5bc7e0c262dfa4bd04f6cb092df5c18b340b8 respectively. All 22 ordered filesystem layer hashes were compared with each actual inspected Docker image and match exactly (catalog-image-binding.json). Catalog config hashes are independently checked; normalization is not mistaken for a different filesystem. Images were built locally and not published.

## 8. Scanner and vulnerability database

Syft 1.54.1 (/syft), pinned sha256:3eb5379ba7b409c3f4069b686110527af0c47df993fa5c10d13e7cf34f49b1aa. Grype 0.120.1 (/grype), pinned sha256:e4a44ef45d285b829ce6efe2642980329661bd2d18eab5fc539138d4adaebbbe. Both verified Linux amd64 at runtime.

Validated Grype database schema v6.1.10, built 2026-10-26T06:38:44Z; archive checksum sha256:214b59fbe13608346ee1b22583ec0531083d6088c33891f3520d0fbdedb1b308. Both provisioning and explicit status succeed. Final scan descriptors report valid/current data; startup hash verification remains enabled. Scans are dated 2026-10-26 and are point-in-time evidence.

## 9. Current image findings

| Complete final image                                    | Packages | All matches | High matches | Critical matches | Unique blocking IDs | Grype / wrapper exit |
| ------------------------------------------------------- | -------: | ----------: | -----------: | ---------------: | ------------------: | -------------------- |
| Original main Bookworm / Node 24.22.0                   |      131 |         236 |           76 |                7 |                  31 | 2 / 1                |
| Patched Bookworm / Node 24.22.1                         |      131 |         222 |           70 |                2 |                  20 | 2 / 1                |
| Full Trixie archive / Node 24.22.1 (runtime unverified) |      122 |         157 |           54 |                0 |                  14 | 2 / 1                |

The same valid database build matched all three complete filesystems. Eleven blocking IDs disappeared: ten fixed Perl advisories and GHSA-mrhx-c7xc-m3w5. The Perl IDs are CVE-2026-12087, CVE-2026-13221, CVE-2026-42496, CVE-2026-42497, CVE-2026-48959, CVE-2026-48962, CVE-2026-57432, CVE-2026-57433, CVE-2026-7017 and CVE-2026-8376. Perl moved 5.36.0-7+deb12u3 to +deb12u4, Node/OpenSSL moved 24.22.0/3.5.8 to 24.22.1/3.5.9. Critical glibc CVE-2026-5450 still matches libc6 and libc-bin. Counts are package matches, not independent vulnerabilities or exploit demonstrations. The gate correctly remains red.

## 10. Official image and distroless assessment

The release Dockerfile deliberately refreshes both official Bookworm stages to node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205. Its compatible reproducible finished image is recorded above. It retains nonroot 1000:1000, production workspace closure, original migrations and direct Node stdio.

Dockerfile.trixie is a separate experimental candidate using node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea. The base runtime probe confirms Node 24.22.1, OpenSSL 3.5.9, Debian 13.7, linux amd64 and UID 1000. Full release builds compile successfully, but automatic import stalls: two ten-minute attempts and a fifteen-minute attempt failed before packaged tests. Sanitized progress identifies completed compilation/layer export followed by the sending-tarball stall; the fifteen-minute attempt records deadline=true, unknown scanner/process exit null and wrapper exit 1.

A separate diagnostic experiment successfully exported the complete 87,917,568-byte Docker archive, then explicit docker image load also hit its five-minute deadline. Docker daemon logs show load requests without corresponding completion while the separate Bookworm imports completed. This isolates the boundary to Docker import; an internal daemon/lock/vendor root cause is not proven. No Docker restart or unrelated-resource cleanup occurred. The failed exporter adaptation is preserved as container-smoke-archive-experiment.ts.txt; the passing default Bookworm smoke path is retained.

The full Trixie archive was nevertheless cataloged/scanned directly under the identical policy. Its config identity is sha256:9c4f2fbf220d10ee626a214f652a4b2b5987bfbcdee5fca7124181b576e7603b; archive SHA256 1e88c2a45b8075564f9c34631c41a2e57226a5bbc27b7d0f58e51c068280fa8a. Docker-format export manifest is sha256:7b05ad2e37d481881b8c64fd81002ebd5ffdb1b7b06b4b751fa1f464632788a9; the earlier OCI-format export manifest differs (sha256:be0535930af3cd1fa34eea07d0341d60015b5557d0257ed8a539c3875465450e), with the same config digest. These are local export identities, not published RepoDigests or a runnable imported image.

Independent cold builds agree on the config digest, and all 17 application/dependency/migration filesystem layers match the runtime-verified Bookworm release exactly. The automated cold-repeat/startup/TLS/tool/lifecycle flow still stops at import; these partial reproducibility/content checks do not establish full runtime compatibility. Grype completes normally against the full archive with 54 High, zero Critical, 14 unique blocking IDs, exit 2/wrapper 1. Trixie removes the Bookworm matches for CVE-2025-13151, CVE-2026-41992, CVE-2026-53613, CVE-2026-53615, CVE-2026-5450 and CVE-2026-5928 through supported vendor fixes, rather than severity overrides.

No image is release-approved. Bookworm remains the runtime-verified baseline with its deliberate Node patch; Trixie is a supported remediation candidate requiring import/runtime verification and resolution of remaining findings, including the separately assessed bundled-zlib concern. It is not promoted based on reduced counts.

The latest resolved distroless candidate is gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8. It is not ported, rebuilt, promoted or freshly scanned in this recovery. Historical October 19 counts/compatibility remain evidence only. No current distroless clean result, bundled-native fix, TLS compatibility or security advantage is claimed. Re-evaluation would require its own complete reproducible packaged tests and scan; no candidate is accepted solely because it contains fewer packages.

## 11. Every remaining High/Critical advisory

Installed Bookworm families: libtasn1-6 4.19.0-2+deb12u1; ncurses-base/ncurses-bin/libtinfo6 6.4-4; gcc-12-base/libgcc-s1/libstdc++6 12.2.0-14+deb12u1; libc6/libc-bin 2.36-9+deb12u14; gzip 1.12-1; bsdutils/libblkid1/libmount1/libsmartcols1/libuuid1/mount/util-linux/util-linux-extra 2.38.1-5+deb12u3 (bsdutils carries epoch 1); libacl1 2.3.1-3; perl-base 5.36.0-7+deb12u4; zlib1g 1:1.2.13.dfsg-1. Exact per-binary matches/fix states and matcher metadata are retained in current-comparison.json.

The table's status is the scanner's current fix state, not an owner disposition. All rows remain blocking. Recommended action for every row: retain the finding, prefer supported vendor-fixed packages when available, rebuild/retest/rescan; otherwise obtain vendor clarification or an explicit owner decision on further remediation. No no-dsa, ignored, postponed or wont-fix label means inapplicable. No unstable packages were installed.

| Advisory/vendor evidence                                                       | Severity / package matches / scanner status | Installed family | Functionality and vendor fix/status                                                                                                              | Observed applicability and limits                                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| [CVE-2025-13151](https://security-tracker.debian.org/tracker/CVE-2025-13151)   | High / 1 / wont-fix                         | libtasn1         | ASN.1 octet expansion overflow. Bookworm no-dsa; Trixie fixed 4.20.0-2+deb13u1.                                                                  | Library present; not in observed Node loaded libraries. No general reachability exemption.                                       |
| [CVE-2025-69720](https://security-tracker.debian.org/tracker/CVE-2025-69720)   | High / 3 / wont-fix                         | ncurses          | infocmp string-analysis overflow. Both stable releases no-dsa; upstream/newer unstable fixed.                                                    | infocmp executable present. No terminal-diff operation exposed by V1 tools.                                                      |
| [CVE-2026-102010](https://security-tracker.debian.org/tracker/CVE-2026-102010) | High / 3 / wont-fix                         | gcc-12           | PBDS binary-heap erase_if use-after-free. Bookworm ignored, Trixie no-dsa; fixed newer GCC branches in unstable.                                 | libstdc++ loaded; development headers absent. Template instantiation/reachability not proven absent.                             |
| [CVE-2026-19499](https://security-tracker.debian.org/tracker/CVE-2026-19499)   | High / 2 / wont-fix                         | glibc            | strfmon padding overflow. Bookworm postponed, Trixie no-dsa; unstable fixed 2.43-5.                                                              | libc loaded; affected strfmon symbols present. No safe global non-reachability claim.                                            |
| [CVE-2026-41992](https://security-tracker.debian.org/tracker/CVE-2026-41992)   | High / 1 / wont-fix                         | gzip             | LZW/LZH decoder shared-state overflow. Bookworm postponed; Trixie fixed 1.13-1+deb13u1.                                                          | gzip executable present; V1 tools expose no archive-decompression command.                                                       |
| [CVE-2026-53613](https://security-tracker.debian.org/tracker/CVE-2026-53613)   | High / 8 / not-fixed                        | util-linux       | Restricted mount target-path race. Trixie fixed 2.41.5-0+deb13u1; no Bookworm fix reported.                                                      | mount executable present. Hardened invocation drops capabilities and blocks privilege gain; no waiver.                           |
| [CVE-2026-53615](https://security-tracker.debian.org/tracker/CVE-2026-53615)   | High / 8 / not-fixed                        | util-linux       | DOS extended-partition arithmetic/bounds flaw. Trixie fixed 2.41.5-0+deb13u1.                                                                    | blkid executable present; tools expose no raw-media probing. Source-wide matches are retained.                                   |
| [CVE-2026-5435](https://security-tracker.debian.org/tracker/CVE-2026-5435)     | High / 2 / wont-fix                         | glibc            | Deprecated resolver TSIG formatting overflow. Both stable releases no-dsa; unstable fixed 2.43-3.                                                | glibc installed/loaded; no complete native resolver call-graph proof.                                                            |
| [CVE-2026-54369](https://security-tracker.debian.org/tracker/CVE-2026-54369)   | High / 1 / wont-fix                         | acl              | Path-following ACL privilege escalation. Bookworm postponed, Trixie no-dsa; new 2.4.0 ABI fix.                                                   | libacl present; setfacl/getfacl absent. Privileged caller/path preconditions not blanket-disproved.                              |
| [CVE-2026-54370](https://security-tracker.debian.org/tracker/CVE-2026-54370)   | High / 1 / wont-fix                         | acl              | Recursive ACL symlink race. Same stable vendor status and 2.4.0 ABI constraint.                                                                  | CLI helpers absent; library/source-level finding retained. No V1 ACL operation.                                                  |
| [CVE-2026-5450](https://security-tracker.debian.org/tracker/CVE-2026-5450)     | Critical / 2 / wont-fix                     | glibc            | Critical: scanf malloc character width over 1024 can overflow. Bookworm no-dsa; Trixie fixed 2.41-12+deb13u4.                                    | libc scanf symbols present and Node imports sscanf/fscanf. Specific vulnerable format path unproven, not excluded.               |
| [CVE-2026-5928](https://security-tracker.debian.org/tracker/CVE-2026-5928)     | High / 2 / wont-fix                         | glibc            | Wide-character pushback under-read/crash. Bookworm vulnerable; Trixie fixed 2.41-12+deb13u4.                                                     | ungetwc present; libstdc++ imports it. Native input/encoding reachability unresolved.                                            |
| [CVE-2026-76642](https://security-tracker.debian.org/tracker/CVE-2026-76642)   | High / 8 / not-fixed                        | util-linux       | Post-mount hook execution after helper failure. Trixie no-dsa; unstable fixed 2.42.3-1.                                                          | mount present; privileged/fstab preconditions restricted by prescribed runtime flags, not suppressed.                            |
| [CVE-2026-78408](https://security-tracker.debian.org/tracker/CVE-2026-78408)   | High / 8 / not-fixed                        | util-linux       | nsenter join-cgroup leaks privileged descriptor. Trixie no-dsa; unstable fixed 2.42.4-1.                                                         | nsenter present; no privileged namespace operation exposed by MCP. Operator misuse remains relevant.                             |
| [CVE-2026-78409](https://security-tracker.debian.org/tracker/CVE-2026-78409)   | High / 8 / not-fixed                        | util-linux       | X-mount.subdir intermediate-symlink traversal. Trixie no-dsa; unstable fixed 2.42.3-1.                                                           | mount present. Host/kernel/fstab preconditions matter; source-package match alone does not prove them.                           |
| [CVE-2026-78410](https://security-tracker.debian.org/tracker/CVE-2026-78410)   | High / 8 / not-fixed                        | util-linux       | Restricted bind source-path race. Trixie no-dsa; unstable fixed 2.42.3-1.                                                                        | mount is setuid 4755, but prescribed no-new-privileges/cap-drop/nonroot controls remain mandatory.                               |
| [CVE-2026-82560](https://security-tracker.debian.org/tracker/CVE-2026-82560)   | High / 1 / not-fixed                        | perl             | Pod::Text nested-POD exhaustion. Stable Debian unfixed/no-dsa; upstream podlators 6.1.1 fix.                                                     | perl-base installed, affected module absent from file list; actual module-load probe exits 2. Finding retained for adjudication. |
| [CVE-2026-85091](https://security-tracker.debian.org/tracker/CVE-2026-85091)   | High / 1 / not-fixed                        | zlib             | Nonblocking gzip writer stale-buffer overflow. Debian stable vulnerable, sid fix 1:1.3.dfsg+really1.3.2-4; older-version applicability disputed. | OS libz present. Node has separate bundled zlib and exports gzwrite/gzprintf/gzvprintf; see detailed unresolved concern below.   |
| [CVE-2026-9538](https://security-tracker.debian.org/tracker/CVE-2026-9538)     | High / 1 / wont-fix                         | perl             | Archive::Tar entry-size exhaustion. Stable postponed; upstream Archive::Tar 3.10/newer unstable Perl fixed.                                      | Actual Archive::Tar load fails; module absent from perl-base list. Scanner source-package match remains blocking.                |
| [CVE-2026-95619](https://security-tracker.debian.org/tracker/CVE-2026-95619)   | High / 3 / wont-fix                         | gcc-12           | Aligned operator-new integer overflow. Bookworm postponed, Trixie no-dsa; fixed newer GCC branches, GCC12 still unfixed.                         | Node imports aligned array new; library implementation present. Large-allocation trigger path not conclusively assessed.         |

### Trixie archive subset

All fourteen IDs are a subset of the fully reviewed table above; no new blocking ID was introduced. Exact per-package matches are in final-comparison.json. Installed groups: ncurses 6.5+20250216-2; GCC14 runtime 14.2.0-19; glibc 2.41-12+deb13u4; libacl1 2.3.2-2+b1; util-linux 2.41.5-0+deb13u1 (bsdutils epoch 1, login 1:4.16.0-2+really2.41.5-0+deb13u1, and liblastlog2-2 included); perl-base 5.40.1-6+deb13u1; zlib1g 1:1.3.dfsg+really1.3.1-1+b1. Functionality/vendor assessments above apply as documented; the Bookworm Perl module/symbol runtime probes are not falsely claimed as Trixie runtime probes.

| Remaining High ID | Package matches | Scanner fix status | Available version in scan                |
| ----------------- | --------------: | ------------------ | ---------------------------------------- |
| CVE-2025-69720    |               3 | wont-fix           | none reported for this installed release |
| CVE-2026-102010   |               3 | wont-fix           | none reported for this installed release |
| CVE-2026-19499    |               2 | wont-fix           | none reported for this installed release |
| CVE-2026-5435     |               2 | wont-fix           | none reported for this installed release |
| CVE-2026-54369    |               1 | wont-fix           | none reported for this installed release |
| CVE-2026-54370    |               1 | wont-fix           | none reported for this installed release |
| CVE-2026-76642    |               9 | wont-fix           | none reported for this installed release |
| CVE-2026-78408    |               9 | wont-fix           | none reported for this installed release |
| CVE-2026-78409    |               9 | wont-fix           | none reported for this installed release |
| CVE-2026-78410    |               9 | wont-fix           | none reported for this installed release |
| CVE-2026-82560    |               1 | wont-fix           | none reported for this installed release |
| CVE-2026-85091    |               1 | not-fixed          | none reported for this installed release |
| CVE-2026-9538     |               1 | wont-fix           | none reported for this installed release |
| CVE-2026-95619    |               3 | wont-fix           | none reported for this installed release |

Immutable Node source evidence records commit ce7aaf1cee78b8cf0ce17364260535c418d3ed26 and gzwrite.c SHA256 2ce783294c688330c716bfe106f43167d3dae5be84994176bc304d205d4f5b04; exact source-to-binary reproducibility is not claimed. Native evidence is in native-symbol-probes.json and the *-native-inventory.json files. Node actually maps libc and libstdc++; aligned array-new and scanf imports exist. Headers being absent does not prove previously compiled template code absent. GNU gzip, infocmp, mount, nsenter and blkid are present. No V1 tool exposes those commands. Prescribed read-only, nonroot, cap-drop and no-new-privileges controls restrict local privilege paths; they do not adjudicate scanner findings or compromised-launcher risk.

Perl module file-list inspection and actual isolated module-load probes show Pod::Text and Archive::Tar absent. This supports reviewing source-package overmatching but does not automatically clear either finding. Original scanner JSON is retained unchanged.

CVE-2026-85091 requires special care. [Debian](https://security-tracker.debian.org/tracker/CVE-2026-85091) still marks Bookworm/Trixie vulnerable despite the description naming later zlib versions. [Upstream discussion](https://github.com/madler/zlib/issues/1310) and [the fix](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148) preserve an affected-range disagreement; neither is a locally approved waiver.

Node also bundles zlib 1.3.2.1-motley-285e94b, separate from OS libz; OS libz is not in the observed initial Node sharedObjects list. The final Node binary nevertheless defines gzwrite/gzprintf/gzvprintf. [Node v24.22.1 immutable source](https://github.com/nodejs/node/blob/ce7aaf1cee78b8cf0ce17364260535c418d3ed26/deps/zlib/gzwrite.c) contains the direct error-return path without the pointer/length reset added by the cited upstream fix; its [build inputs](https://github.com/nodejs/node/blob/v24.22.1/deps/zlib/BUILD.gn) include gzip writer code. This is an additional unresolved bundled-component concern, not a new invented Grype match or proof of MCP exploitability. Native call-path/binary patch equivalence and vendor confirmation are still needed. Do not infer safety from a different version suffix or fewer OS packages.

## 12. Non-integration verification and logging

npm run verify passes: 511 tests in 22 files; formatting, lint, build/typecheck included. Invocation severity remains success info, expected application/RATE_LIMITED warn, INTERNAL_ERROR error. Tests retain one invocation record, requestId/metadata, warning-level visibility, safe responses, SDK pre-callback validation and protection against throwing log sinks corrupting protocol output. No payload or secrets are logged.

## 13. Real PostgreSQL integration

npm run verify:all passes with 441 integration tests in 18 files and three platform-specific skips, plus the 511 non-integration tests. PostgreSQL 18 ran in an invocation-owned container backed by tmpfs, with a random localhost port and throwaway credentials. Existing databases/volumes were not reused, reset or deleted. Trusted pg_dump/pg_restore clients remain 18.6. H1 migration serialization and H2 backup/restore, tenant/permission boundaries, concurrency/idempotency and cleanup tests passed. Windows skips do not substitute for Linux CI.

## 14. Container smoke

The patched Bookworm release passed npm run test:container, identical cold rebuild, all eight tools, note/audit idempotency, verified PostgreSQL TLS, readiness rejections, protocol-only stdout, nonroot execution, no application listeners, all eleven original migration assets and EOF/SIGINT/SIGTERM. M8-C shutdown and M8-E limits remain unchanged. Trixie packaged runtime checks remain blocked at Docker import, including the explicit archive-load attempt. Its full archive vulnerability result is valid, but does not substitute for startup, verified database TLS, signal handling or automated cold-repeat verification.

## 15. Migration integrity

npm run db:check passes. npm run db:generate reports no schema changes/nothing to migrate. No migration diff or SQL/metadata change; all eleven files are checked in packaged smoke. No migration was added or automatic migration startup introduced.

## 16. CI gate status

Merged main's [run 40309126177](https://github.com/belovedjohndev/beloveddev-mcp/actions/runs/40309126177) passed verification/container jobs. This uncommitted branch has not run remotely. CI preserves PostgreSQL 18 recovery clients, explicit migration URL, H1/H2 integration and no-drift verification; pinned Actions, production/full audits, live proofs and exact-image scanning remain mandatory. The container job has a finite 90-minute budget for cold builds/provisioning. High/Critical thresholds and database policy are unchanged. Local production/full audits and proof are green; the actual release-image gate is red. Required repository status checks remain owner-managed.

## 17. Preservation and remaining limitations

Current source hashes confirm all 158 original checkout files and 160 M8-H files, including HEADs, unchanged. Existing original scanner reports/triage/owner ZIP were never edited; the prior preservation report covers 193 historical report files. All 30 pre-existing container IDs and all 51 pre-existing volume identities/creation times were verified intact. Only invocation-owned verification resources are cleaned up. Temporary scanner caches/test clusters/builders belong only to this invocation and may be retired; no existing persistent data resource is eligible for cleanup.

Generated archives/SBOMs/scan JSON/logs remain ignored and unstaged. Public summary documentation is for source review; raw reports are not committed. Local stdio still trusts OS account/launcher/protected environment and does not provide independent remote authentication. No RLS, blanket native non-reachability, universal redaction or future-vulnerability assurance is claimed.

## 18. Acceptance and owner decisions

Scanner recovery is reviewable and the known compatible dependency patches are verified. **Do not mark M8-G complete or accept the release while the gate is red.** Remaining owner choices: pursue supported vendor fixes/backports; request upstream clarification for bundled Node zlib and source-package/range disagreements; or separately authorize further minimal-image experiments with complete compatibility/security evidence. This task grants no suppression, exception, threshold change or deployment approval. Source review may proceed with blockers explicitly visible; release approval may not.

No HTTP transport, authentication system/bypass, tool-contract/domain change, automatic mutation retry, migration, production deployment, image publication, commit or push occurred. Stop after verification.

## Final verification summary

| Command/check                                | Final result                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| npm ci --ignore-scripts --no-audit --no-fund | Passed; locked compatible graph                                           |
| npm run format / format:check                | Passed                                                                    |
| npm run verify                               | Passed: 511 non-integration tests, 22 files                               |
| npm run verify:all                           | Passed: additionally 441 PostgreSQL tests, 18 files, three platform skips |
| npm run db:check / db:generate               | Passed; no drift or migration diff                                        |
| npm run test:container                       | Passed, exact default Bookworm image; identical cold rebuild              |
| Production/full npm audits                   | Exit 0, zero vulnerabilities each                                         |
| npm run security:verify                      | Exit 0, actual A?F and all 13 proof flags                                 |
| Complete original/patched Bookworm scans     | Grype 2 each; wrapper 1, genuine vulnerability-policy failures            |
| Complete Trixie archive scan                 | Grype 2; wrapper 1, genuine vulnerability-policy failure                  |
| Trixie full packaged runtime                 | Blocked at import; not passed or promoted                                 |
| git diff --check                             | Exit 0                                                                    |
| Original/M8-H preservation                   | 158/160 source files and heads unchanged                                  |
| Existing Docker resources                    | All 30 container IDs and 51 volume creation identities preserved          |
| Commit/push/publish/deployment               | None                                                                      |

## Local evidence index

- Recovery directory: .security-reports/recovery-20261026-84116e8e-50b1-4b8b-b559-f9bd9fc99ec2 (sanitized command evidence, both audits, source preservation, native/module probes, failed Trixie attempts, final verification logs).
- Live proof: .security-reports/run-ebc0c2cc-1edd-43dc-ac8f-e26582448c10 (13 true flags and real scanner exits).
- Complete original/patched image comparison: .security-reports/run-4c33d8bf-c7e8-4d07-9aff-d32af7f0b829.
- Complete Trixie archive scan: .security-reports/run-9ec04c00-8a79-48a7-ae3d-f69aba82f2e4; final-comparison.json retains all three current sets.
- Final verify:all: verify-all-ecfc399e-88e3-4d47-874b-7bb6afc998bd.{stdout.log,stderr.log,exit.json}; 511 + 441 passing, three skips, exit 0. The archival-lint failure is retained separately, corrected by storing the snapshot as text without relaxing ESLint.
- Final exact default container run: bookworm-final.{stdout.log,stderr.log,exit.json}, exit 0 in 456639 ms; same immutable image and cold rebuild.
- Earlier original reconciliation artifacts and failed recovery runs remain intact; historical counts are never substituted for these current reports.

## M8-G3 update - 2026-10-27

**Diagnosis and experiment are complete for owner review; M8-G and release acceptance remain blocked.** Both experimental images now pass the packaged runtime checks on an independent engine. Both fail the unchanged vulnerability gate. No image is promoted, no finding is waived, and the runtime-verified Bookworm Dockerfile remains the working baseline. Earlier sections and their verification summary describe the October 26 recovery; this update supersedes their unresolved Trixie-runtime conclusion. The complete pre-update report is preserved byte for byte in .security-reports/m8-g3-20261027/review-before-m8-g3.md.

### 1. Import diagnosis and independent engine

Read AGENTS.md and the requested security documents, pins, policy, actual Dockerfiles, source composition root, test helpers and retained diagnostics. Work stayed in BelovedDev-MCP-M8G on feat/m8-g-security, HEAD 2e56b7a2aa61fa7b8bfa8102335a8e87df8338e7. The existing dirty worktree was preserved. This slice adds Dockerfile.distroless and updates this report; generated evidence is ignored under .security-reports/m8-g3-20261027 and the new scan directory.

The retained Trixie archive is still exactly 87,917,568 bytes, SHA256 1e88c2a45b8075564f9c34631c41a2e57226a5bbc27b7d0f58e51c068280fa8a, config sha256:9c4f2fbf220d10ee626a214f652a4b2b5987bfbcdee5fca7124181b576e7603b. Its SHA256 was recomputed before import. Earlier full build/export succeeded; Docker Desktop automatic import and the separate five-minute load failed to finish. Historical daemon load-entry/no-completion evidence remains preserved. Today the image was still absent from Desktop, while version/info/metadata requests responded without daemon warnings. No new Desktop load attempt was made.

| Observed property | Affected Docker Desktop engine                                         | Independent Ubuntu engine                                                                            |
| ----------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Engine ID         | a896ba85-5506-4a4d-98f9-32cd8abe6e34                                   | 46e2f828-b350-4f63-9940-8b8a9394631b                                                                 |
| Version           | Desktop 4.56.0 (214940), Engine 29.1.3, containerd 2.2.1               | Existing snap Docker Engine 29.8.0, containerd 2.3.4                                                 |
| Image store       | overlayfs, io.containerd.snapshotter.v1; UseContainerdSnapshotter=true | overlay2, separate /var/snap/docker/common/var-lib-docker                                            |
| Buildx            | docker driver, BuildKit 0.26.2                                         | Existing CLI plugin 0.30.1-desktop.1; test creates private docker-container builders                 |
| Resources         | 4 CPUs, 5,977,489,408 bytes VM RAM                                     | Shares the WSL2 kernel/VM CPU and memory; independent daemon/store, not an independent physical host |

The default and desktop-linux Windows contexts resolve to the same Desktop engine. Ubuntu's default Docker-info probe initially timed out, but explicit unix:///var/run/docker.sock reached its separate snap daemon. Its PID/config/data root and different engine ID establish independence; merely being in WSL would not. No engine was installed or reconfigured. The snap engine reports Moby module v2.0.0-beta.23+dirty; these are local diagnostic results, not certification of a production engine or Linux CI.

A single explicit 180-second load comparison on Ubuntu succeeded in **37,884 ms, exit 0**, using the identical retained archive. Later source-only builds and packaged tests also succeeded there. This rules out an intrinsically unreadable archive and shows the application can run in the tested environment. It does not isolate a single Desktop/containerd defect: engine version, store backend and existing state differ. Image-store contention, internal daemon locks and a specific vendor bug remain unproven. It is an import-path operational failure, not compilation/export failure or application startup failure.

Current host C: free space was about 190.8 GB (decimal). Desktop's data filesystem reported about 1.00 TB available logical guest space; Ubuntu's filesystem about 1.02 TB. Guest capacity is not host physical capacity. WSL snapshots showed about 3.1-3.5 GB available memory and about 1 GB swap used. No ENOSPC or OOM evidence established a resource root cause; current snapshots cannot disprove historical pressure. No restart, prune, reset, backend switch or deletion of existing resources was attempted.

The successful Trixie retry builder was invocation-owned, using the existing digest-pinned BuildKit 0.26.1, with 2 GiB/2 CPU bounds. The first independent builder identity is recorded as beloveddev-release-415dca7f-8292-4fa6-afde-56d97897a510; all test builders use fresh UUIDs and the unchanged helper cleans up only its own builder. The passing retry and distroless helper do not emit their builder UUIDs; the bounded daemon event history no longer retained them. Their exact final artifact IDs, pinned builder image, settings and cold-repeat outcomes are recorded, but complete builder-event provenance is a remaining diagnostic limitation. Initial Windows-worktree Git metadata was unreadable to Linux Git because its pointer uses a Windows absolute path. A new bare Git metadata view, inside this run's ignored evidence directory, supplied the identical 171-file source listing without changing the real worktree or index. The first full helper attempt then passed both builds but failed at PostgreSQL provisioning. After PostgreSQL 18 image prefetch, the existing isolated TLS fixture passed; the full Trixie retry passed. Failed attempts remain recorded, not relabeled as successes.

### 2. Exact candidates and operating checks

Bookworm baseline remains node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205, with the previously verified final image sha256:987565e42e09f98fa57ee7428d527083180b44825628562dce9ae568706005c5.

Trixie remains experimental: node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea. The new Linux-built/tested final image config is **sha256:a746ab3d8b1fb6b43e98960f7baf7aaffbf1e5da192d4a3c6b3c3ed172b575f2**. Its complete saved archive is 272,961,536 bytes, SHA256 82ef4ff62629d4543618ef4a64a87140977d3dd82228a961e8e8ec319faec833.

The official current distroless index was re-resolved without import: **gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8**, amd64 manifest sha256:4d0e659ef1f628c75d9940766cb444fa9605cc190b13676b9e62e1fa567c5cf4. It matches the prior resolved candidate, but was now actually built and tested. Dockerfile.distroless preserves the Trixie build/production-dependency stages, lockfile, six compiled runtime workspaces, and all eleven original migration assets. Its final stage has no RUN/shell, uses USER 65532:65532, and directly executes /nodejs/bin/node with the compiled server entry point. No development dependency/source copy, secret, new launcher wrapper or HTTP listener is introduced.

The distroless final image config is **sha256:daac2f86bda0fbe6076b116fa2a8378c502c37c795f8caaa977a01332b9c03af**. Its complete saved archive is 189,872,128 bytes, SHA256 35c2b7b7625996e3aed18957a2e51f8f7bf7b6cb50261b667d09678d14ae884c. Final image configs identify local artifacts; they are not published registry RepoDigests.

Both exact images report Node 24.22.1, OpenSSL 3.5.9 and bundled zlib 1.3.2.1-motley-285e94b. Trixie uses UID 1000 and distroless UID 65532. The unchanged helper verifies strict schemas/annotations and all eight tools, direct stdio with every stdout line valid JSON-RPC, logs only on stderr, no Node application listeners, verified PostgreSQL TLS, readiness, tenant rejection, spoofed tenant rejection, one note/one audit after duplicate-key execution, fixed M8-E limits, eleven migration hashes, and orderly EOF/SIGINT/SIGTERM. Six safe startup rejections include production/local-auth rejection, unsupported auth, bad secret, dangerous DB privileges, insecure remote transport and missing migration assets. Distroless inspection additionally proves shell/package-manager/npm paths absent using Node, not a shell entrypoint.

### 3. Fresh complete-image scans and comparison

Both exact tested archives were independently cataloged and scanned together through the unchanged scripts/security-check.ts image command. A new scan was warranted for the new final artifacts and a contemporaneous comparison; historical baseline scans and expensive enforcement fixtures were not repeated. Installed runtime SDK/Zod/pg and OS inventories passed the existing checks, with development tools excluded. Syft 1.54.1 and Grype 0.120.1 remain pinned to the same immutable images.

Database schema v6.1.10, built 2026-10-27T06:30:41Z, valid=true. The downloaded archive checksum is SHA256 16a9163729d925edbf911db3542666748f06ddb2ce541211a4f1314349e20442. Update/status succeeded; matching retained successful update checking, startup hash validation, the 120-hour age limit and empty local ignore/exclude/VEX lists. High/Critical including unfixed remains blocking.

| Complete final artifact                    | Packages | All matches | High matches | Critical matches | Unique blocking IDs | Grype exit |
| ------------------------------------------ | -------: | ----------: | -----------: | ---------------: | ------------------: | ---------: |
| Patched Bookworm, retained October 26 scan |      131 |         222 |           70 |                2 |                  20 |          2 |
| Trixie, tested Linux build                 |      122 |         157 |           54 |                0 |                  14 |          2 |
| Distroless, tested Linux build             |       56 |          31 |           11 |                0 |                   5 |          2 |

The two fresh scans use the same October 27 database. Bookworm's retained result uses the October 26 database and is labeled accordingly. Wrapper exit **1**, failure kind **vulnerability_policy**, is expected for both blocked candidates; it is not scanner operational failure. The complete two-image invocation took 594,789 ms. Full JSON/SBOM/exit/command/database records are in .security-reports/run-796013ea-f9e8-4f00-953e-3197f5183b33.

Distroless removes nine of Trixie's fourteen blocking IDs, reducing High package matches from 54 to 11 and introducing no new unique blocking ID. Remaining IDs are **CVE-2026-102010, CVE-2026-19499, CVE-2026-5435, CVE-2026-85091 and CVE-2026-95619**. The GCC IDs each match four packages in distroless versus three in Trixie because distroless also installs libgomp1 14.2.0-19. Its two extra source-package matches are retained. libc-bin is absent, while libc6 remains affected; fewer glibc matches do not mean its shared library is patched.

Complete filesystem enumeration and actual runtime path probes, rather than package metadata alone, show the ncurses/infocmp, ACL library/helpers, util-linux libraries/executables, and Perl interpreter/modules absent in distroless. No corresponding paths were found, and neither shell nor package manager exists. By contrast Node, libc, libstdc++ and OS libz are byte-identical between candidates. Thus removal is real for the inspected families but provides no remediation for the remaining native binaries or bundled zlib.

### 4. Per-CVE technical triage

All fourteen original Trixie High IDs remain in the fresh Trixie scan; none was silently removed. The following records combine exact package versions, scanner state, vendor status, required functionality/preconditions, actual presence/native evidence and limitations. They are evidence, not VEX or exceptions. Every remaining match continues to block. For each: seek vendor clarification or a supported stable fix, then rebuild, verify and rescan. No unstable Debian package was installed. Complete structured records, including every distroless match, are in triage-current.json.

#### CVE-2025-69720 - ncurses

High; 3 Trixie matches and 0 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: libtinfo6 6.5+20250216-2; ncurses-base 6.5+20250216-2; ncurses-bin 6.5+20250216-2.

Function: infocmp analyze_string stack overflow. Requires execution of infocmp against crafted terminal descriptions/string comparisons. No V1 tool provides that operation; compiled library reachability is not globally excluded.

Presence/native evidence: infocmp executable is present in the exact archive; libtinfo is installed.

Vendor status and supported-fix limit: Trixie no-dsa; Debian unstable fixed 6.6+20251231-1, upstream 6.5-20251213. No stable fixed package reported. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2025-69720).

#### CVE-2026-102010 - GCC/libstdc++

High; 3 Trixie matches and 4 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: gcc-14-base 14.2.0-19; libgcc-s1 14.2.0-19; libstdc++6 14.2.0-19. Distroless additionally matches libgomp1 14.2.0-19.

Function: PBDS binary-heap erase_if use-after-free. Requires a compiled PBDS binary heap instantiation and attacker influence over erase_if operations that reallocate. Header absence does not exclude already compiled templates; no exhaustive optimized call graph was established.

Presence/native evidence: libstdc++ is a Node ELF dependency. Development headers and native .node add-ons are absent from the archived filesystem. Distroless additionally installs libgomp1 14.2.0-19, also matched indirectly through GCC source metadata; it is not in observed Node sharedObjects.

Vendor status and supported-fix limit: Trixie GCC14 no-dsa; unstable GCC14 fixed 14.4.0-3. No supported stable fix reported. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-102010).

#### CVE-2026-19499 - glibc

High; 2 Trixie matches and 1 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: libc-bin 2.41-12+deb13u4; libc6 2.41-12+deb13u4.

Function: strfmon/strfmon_l right-justified padding overflow. Requires an application invoking the monetary formatter with susceptible width/padding and destination size. Attacker-controlled format is not strictly required. Ordinary libc linkage does not prove that call; complete native reachability remains unproven.

Presence/native evidence: libc is present and a Node ELF dependency; the affected API exists in this glibc family.

Vendor status and supported-fix limit: Trixie no-dsa; unstable fixed 2.43-5. No supported stable fix reported. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-19499).

#### CVE-2026-5435 - glibc

High; 2 Trixie matches and 1 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: libc-bin 2.41-12+deb13u4; libc6 2.41-12+deb13u4.

Function: Deprecated resolver TSIG formatting writes beyond supplied bound. Requires the deprecated record-printing functions with a TSIG record and unsuitable buffer. DNS resolution alone does not establish this printing path; indirect loading/calls were not globally disproven.

Presence/native evidence: libresolv.so.2 is in the exact archive and exports __fp_nquery. It is not a direct Node DT_NEEDED dependency.

Vendor status and supported-fix limit: Trixie no-dsa; unstable fixed 2.43-3. No supported stable fix reported. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-5435).

#### CVE-2026-54369 - ACL

High; 1 Trixie matches and 0 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: libacl1 2.3.2-2+b1.

Function: Path-based libacl APIs follow symlink components. Requires a privileged caller processing a path whose component an attacker can replace. Missing CLI tools do not remove library APIs; no V1 ACL operation or direct Node dependency was found.

Presence/native evidence: libacl.so.1.1.2302 is present; getfacl/setfacl/chacl executables are absent.

Vendor status and supported-fix limit: Trixie no-dsa; planned point update requires new 2.4.0 ABI, not individual backports. Unstable fixed 2.4.0-1; no current stable fix. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-54369).

#### CVE-2026-54370 - ACL

High; 1 Trixie matches and 0 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: libacl1 2.3.2-2+b1.

Function: Recursive ACL walk symlink TOCTOU. Requires a privileged recursive ACL walk over an attacker-controlled path and a winning race. CLI absence is stronger evidence for this specific command path, but no exception is applied to the source-package match.

Presence/native evidence: libacl is present; getfacl/setfacl/chacl executables are absent in the exact archive.

Vendor status and supported-fix limit: Trixie no-dsa; requires 2.4.0 ABI and walk_tree rewrite. Unstable fixed 2.4.0-1; no current stable fix. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-54370).

#### CVE-2026-76642 - util-linux

High; 9 Trixie matches and 0 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: bsdutils 1:2.41.5-0+deb13u1; libblkid1 2.41.5-0+deb13u1; liblastlog2-2 2.41.5-0+deb13u1; libmount1 2.41.5-0+deb13u1; libsmartcols1 2.41.5-0+deb13u1; libuuid1 2.41.5-0+deb13u1; login 1:4.16.0-2+really2.41.5-0+deb13u1; mount 2.41.5-0+deb13u1; util-linux 2.41.5-0+deb13u1.

Function: Privileged post-mount hooks run after failed mount helper. Requires applicable mount helper/hooks and privileged mount/fstab configuration, e.g. X-mount.idmap/owner. Prescribed nonroot/cap-drop/no-new-privileges restrict privilege gain without adjudicating the finding.

Presence/native evidence: mount and libmount are present in the exact archive.

Vendor status and supported-fix limit: Trixie no-dsa; unstable fixed 2.42.3-1. No supported stable fix reported. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-76642).

#### CVE-2026-78408 - util-linux

High; 9 Trixie matches and 0 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: bsdutils 1:2.41.5-0+deb13u1; libblkid1 2.41.5-0+deb13u1; liblastlog2-2 2.41.5-0+deb13u1; libmount1 2.41.5-0+deb13u1; libsmartcols1 2.41.5-0+deb13u1; libuuid1 2.41.5-0+deb13u1; login 1:4.16.0-2+really2.41.5-0+deb13u1; mount 2.41.5-0+deb13u1; util-linux 2.41.5-0+deb13u1.

Function: nsenter --join-cgroup privileged descriptor inheritance. Requires a privileged operator joining an attacker-controlled target cgroup and executing a payload that inherits the descriptor. V1 tools do not invoke nsenter. Operator/launcher compromise remains a separate boundary.

Presence/native evidence: nsenter is present in the exact archive.

Vendor status and supported-fix limit: Trixie no-dsa; unstable fixed 2.42.4-1. No supported stable fix reported. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-78408).

#### CVE-2026-78409 - util-linux

High; 9 Trixie matches and 0 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: bsdutils 1:2.41.5-0+deb13u1; libblkid1 2.41.5-0+deb13u1; liblastlog2-2 2.41.5-0+deb13u1; libmount1 2.41.5-0+deb13u1; libsmartcols1 2.41.5-0+deb13u1; libuuid1 2.41.5-0+deb13u1; login 1:4.16.0-2+really2.41.5-0+deb13u1; mount 2.41.5-0+deb13u1; util-linux 2.41.5-0+deb13u1.

Function: X-mount.subdir intermediate symlink traversal. Requires Linux >=6.15 detached-tree path, an fstab-authorized X-mount.subdir entry, attacker-controlled path resolution and mount privilege. Kernel prerequisite is met; remaining prerequisites were not demonstrated or categorically excluded.

Presence/native evidence: mount and libmount are present; the current host kernel is 6.18.54.1.

Vendor status and supported-fix limit: Trixie no-dsa; unstable fixed 2.42.3-1. No supported stable fix reported. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-78409).

#### CVE-2026-78410 - util-linux

High; 9 Trixie matches and 0 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: bsdutils 1:2.41.5-0+deb13u1; libblkid1 2.41.5-0+deb13u1; liblastlog2-2 2.41.5-0+deb13u1; libmount1 2.41.5-0+deb13u1; libsmartcols1 2.41.5-0+deb13u1; libuuid1 2.41.5-0+deb13u1; login 1:4.16.0-2+really2.41.5-0+deb13u1; mount 2.41.5-0+deb13u1; util-linux 2.41.5-0+deb13u1.

Function: Restricted bind-mount source replacement race. Requires an authorized fstab bind source or writable ancestor that can be replaced before privileged mount, plus relevant owner/group/mode hooks for inode changes. Container flags restrict elevation but are not a waiver.

Presence/native evidence: mount and libmount are present.

Vendor status and supported-fix limit: Trixie no-dsa; unstable fixed 2.42.3-1. No supported stable fix reported. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-78410).

#### CVE-2026-82560 - Perl

High; 1 Trixie matches and 0 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: perl-base 5.40.1-6+deb13u1.

Function: Pod::Text nested POD CPU/memory exhaustion. Requires the affected formatter module and hostile POD nesting. Current Trixie filesystem supports reviewing source-package overmatching; no automatic scanner exclusion or vendor-accepted inapplicability is claimed.

Presence/native evidence: perl executable exists; complete archive path enumeration finds no Pod/Text.pm. Earlier Bookworm module-load probes are separate evidence. Exact smoke-tested Trixie module-load probes now also exit 2 with module-not-found.

Vendor status and supported-fix limit: Trixie no-dsa, Perl/podlators packages unfixed even in unstable; upstream podlators fixed in 6.1.1. No stable fix reported. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-82560).

#### CVE-2026-85091 - zlib

High; 1 Trixie matches and 1 distroless matches. Scanner fix state: not-fixed; no fixed version reported for the installed release.

Trixie packages: zlib1g 1:1.3.dfsg+really1.3.1-1+b1.

Function: Retryable gzip writer external-buffer overflow. Requires a gzip file handle backed by a nonblocking descriptor, a sufficiently large external-buffer write that stalls, and later gzip printf handling. Ordinary JS gzip streams use deflate rather than gz-file APIs. OS affected-range disagreement and bundled reachability remain unresolved.

Presence/native evidence: OS libz.so.1.3.1 is present; its exact SHA256 and gzvprintf disassembly are retained. Node has a distinct compiled bundled writer with a pre-fix error path.

Vendor status and supported-fix limit: Debian stable vulnerable, sid fixed 1:1.3.dfsg+really1.3.2-4. Upstream reset fix df84af25; no stable fixed package or Node vendor adjudication established. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-85091).

#### CVE-2026-9538 - Perl

High; 1 Trixie matches and 0 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: perl-base 5.40.1-6+deb13u1.

Function: Archive::Tar unbounded attacker-declared entry allocation. Requires the affected Archive::Tar module processing a crafted header with a huge declared size. Absent module supports overmatch review but is not an approved disposition.

Presence/native evidence: perl exists; complete archive path enumeration finds no Archive/Tar.pm. Exact smoke-tested Trixie module-load probes now also exit 2 with module-not-found.

Vendor status and supported-fix limit: Trixie postponed pending upstream regressions; unstable Perl fixed 5.42.3-1 and upstream Archive::Tar 3.10. No current stable fix reported. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-9538).

#### CVE-2026-95619 - GCC/libstdc++

High; 3 Trixie matches and 4 distroless matches. Scanner fix state: wont-fix; no fixed version reported for the installed release.

Trixie packages: gcc-14-base 14.2.0-19; libgcc-s1 14.2.0-19; libstdc++6 14.2.0-19. Distroless additionally matches libgomp1 14.2.0-19.

Function: Aligned operator-new size rounding overflow. Upstream says the vulnerable rounding concerns allocation backends other than posix_memalign. This exact binary uses the stated unaffected backend for the inspected overload, supporting an architecture/build-specific applicability dispute. Other binaries/overloads and runtime manipulation are not blanket excluded.

Presence/native evidence: Exact Trixie libstdc++ SHA256 972bb2a18b71140dab0240f8a1f68ab3fb1d56bcd4c4f824a91b70888faf5a00: aligned operator new calls posix_memalign at 0xb3c81; Node imports aligned array new. The imported array-new overload jumps to the inspected scalar aligned-new implementation at 0xb3cc4. Distroless additionally matches libgomp1 14.2.0-19; it is installed but not in the observed Node loaded-library list. This is a GCC source-package match, not proof libgomp implements the vulnerable allocator.

Vendor status and supported-fix limit: Trixie GCC14 no-dsa; unstable GCC14 fixed 14.4.0-3. No stable patch reported; evidence does not remove the policy match. [Debian advisory](https://security-tracker.debian.org/tracker/CVE-2026-95619).

### 5. Bundled Node zlib and CVE-2026-85091

**Debian OS library:** zlib1g 1:1.3.dfsg+really1.3.1-1+b1 is present in both images. Exact libz.so.1.3.1 SHA256 is 85590dd58edf5445e18bc7193e5ebc01ac5841f1ae187e97705a662e90c6421e. [Debian still marks stable vulnerable](https://security-tracker.debian.org/tracker/CVE-2026-85091), although the description names 1.3.1.2-1.3.2. The [upstream discussion](https://github.com/madler/zlib/issues/1310), including the Debian maintainer's range question, remains unresolved for this assessment. Old-version source and exact OS gzvprintf disassembly show an error-return branch before the later memmove, unlike the retryable writer flow. This strengthens the affected-range question without adjudicating it, proving all older paths safe, or accepting another comment as a vendor disposition. The observed binary hash also matches the public discussion's reported Debian binary; this experiment does not independently authenticate that comment's entire Debian source-build chain.

**Node source:** immutable Node commit ce7aaf1cee78b8cf0ce17364260535c418d3ed26 has gzwrite.c SHA256 2ce783294c688330c716bfe106f43167d3dae5be84994176bc304d205d4f5b04. Its direct-buffer error branch lacks the input-pointer/length resets added by [upstream fix df84af25](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148). Nonblocking support originated in 81cc0beb; build inputs include gzwrite.c. Source names and version suffix alone are not a binary verdict.

**Actual compiled binary:** both tested Node executables hash to **e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb**, 126,879,696 bytes. Disassembly confirms gzwrite calls internal gz_write at 0x1a27790. The direct external-buffer gz_comp error branch at 0x1a278dd-0x1a2790c returns without resetting next_in/avail_in. gzvprintf contains the inlined vacate/compression/memmove path, including calls at 0x1a27e4b/0x1a27ebb. This confirms the pre-fix native code pattern in the actual shipped executable, strengthening the earlier source-only concern. It does not establish a reproduced corrupting input or exact source-to-release reproducibility. An empty disassembly for standalone gz_vacate reflects no separately emitted symbol, not code absence; the relevant code is visible in gzvprintf.

**Reachability:** inspected immutable [Node binding source](https://github.com/nodejs/node/blob/ce7aaf1cee78b8cf0ce17364260535c418d3ed26/src/node_zlib.cc) sends GZIP/DEFLATE modes through deflate(), and decompression through inflate(), without gz-file calls. Normal JS gzip streams are different from gzwrite on a nonblocking file handle followed by gzprintf/gzvprintf. No V1 tool exposes that native sequence, arbitrary FFI or subprocess execution; no .node add-on was found in the full Trixie archive. The server composition root does not wire database recovery subprocess capabilities into MCP. These are bounded observations, not a complete optimized native call graph or proof of non-exploitability. Initial loaded libraries include libc/libstdc++ but not OS libz; later loading is not ruled out.

**Disposition:** the upstream zlib bug/fix exists, and the corresponding pre-fix compiled path is present. An exploitable MCP input path or reproduced corruption was not established, and a Node vendor determination was not obtained. [Node 24.22.1 release notes](https://nodejs.org/en/blog/release/v24.22.1) do not provide an adjudication of this finding. Do not label Node universally unaffected or infer that an OS zlib update repairs a statically bundled copy. The bundled concern is additional to, not an invented extra match in, the scanner totals. Both components require vendor review or supported remediation; no waiver is applied.

### 6. Other native evidence and remaining uncertainties

The exact shared libc SHA256 is 9792e3cbb541c8f44c7acf5f14f4022ea62998ecc787d326bed4d8b6547dfd92; libstdc++ SHA256 is 972bb2a18b71140dab0240f8a1f68ab3fb1d56bcd4c4f824a91b70888faf5a00. Both are actually loaded by Node. Removing libc-bin does not change libc6's code. Actual libgomp.so.1.0.0 is present in distroless, SHA256 6456b504ac347bd50c419667440b691f6966ad8aff5309d2f06c977fe2f9debe, but is not in the observed Node loaded-library list.

For CVE-2026-95619, the exact aligned array-new entrypoint imported by Node delegates to scalar aligned new; that implementation calls posix_memalign at 0xb3c81. [The upstream GCC fix](https://github.com/gcc-mirror/gcc/commit/200183d4ab5d57575f3dfebc6af3baf649910b9e) explicitly distinguishes the POSIX backend from the vulnerable rounding implementations. This supports a build/architecture-specific applicability dispute. It does not justify clearing all GCC source-package matches or other builds. PBDS template usage for CVE-2026-102010 remains unresolved; missing development headers do not prove absent compiled instantiations.

Exact Trixie read-only/network-disabled Perl module-load probes now independently fail with exit 2 for both Pod::Text and Archive::Tar, consistent with full filesystem absence. No finding is suppressed on that basis. Deprecated resolver formatting, monetary formatting, ACL and privileged mount preconditions are documented per advisory; absence of a corresponding MCP command is not a blanket native-library exemption. Vendor no-dsa/wont-fix/postponed labels do not change scanner severity or establish non-applicability.

### 7. Reproducibility and artifact-permission caveat

Each candidate passed its unchanged helper's cold --no-cache rebuild comparison, SOURCE_DATE_EPOCH=0 and rewrite-timestamp=true, with matching final config IDs on the tested Ubuntu engine. All 4,693 application filesystem paths have identical content across the two candidates, with no extra application path. All eleven original migration assets are verified by the smoke helper. Both image archives were hash-bound to their full catalog config and ordered filesystem layers.

The new Linux Trixie image differs from the retained Windows-produced config. Offline comparison of **8,571 filesystem paths** found no file-content/type/link differences and **18 permission differences**: seven package manifests and eleven migration assets changed from 0755 to 0777 when copied from the Windows-mounted source under Linux. This explains the differing layers/config; do not claim cross-host digest identity. Distroless shares these application input modes. Tests execute with read-only root filesystems, nonroot users, no capabilities and no-new-privileges, so writable modes did not enable writes during the checks. They are still a packaging limitation if read-only protection is omitted. Normalize source/artifact modes in a separate reviewed packaging slice before accepting a canonical cross-host release artifact. No such fix or baseline permission change was made here.

The old archive's smaller compressed representation and new legacy-daemon export's larger representation are recorded separately; archive SHA256s and config IDs must not be interchanged. Reproducibility is established within each tested build context/engine, not universally across architectures, file modes, registries or future dependency registries.

### 8. Tests actually executed in M8-G3

| Check                                                              | Actual result                                                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Retained Trixie archive hash and independent 180-second load       | Passed, exit 0 in 37.884 seconds                                                  |
| Initial unchanged Linux helper                                     | Git prerequisite failed before build; recorded                                    |
| First helper with corrected Linux source view                      | Builds/artifact inspection passed; PostgreSQL provisioning failed; recorded       |
| Existing isolated TLS PostgreSQL prerequisite after image prefetch | Passed; new fixture cleaned up                                                    |
| Unchanged helper --trixie, Node 24.22.1                            | Passed, exit 0 in 247,558 ms; identical cold rebuild and full packaged assertions |
| Unchanged helper --distroless, Node 24.22.1                        | Passed, exit 0 in 384,273 ms; identical cold rebuild and full packaged assertions |
| Existing security-policy unit tests                                | 18 passed in one file; exit 0                                                     |
| Actual Trixie Perl module-load probes                              | Both exit 2, expected module-not-found evidence; not application failures         |
| Full final-image Syft/Grype checks                                 | Both Grype 2; wrapper 1, vulnerability_policy; valid current database             |
| Native disassembly/full filesystem comparisons                     | Completed; exact hashes and raw results retained                                  |

The prior 511 non-integration and 441 PostgreSQL tests with three Windows platform skips, production/full npm audits and real A-F enforcement fixtures remain retained baseline evidence. They were not rerun as part of this diagnosis-only slice and are not represented as newly passed. The new packaged tests use fresh PostgreSQL tmpfs containers with verified TLS and actual note/audit queries. No in-flight lost-response scenario is newly claimed: the existing same-key recovery semantics and prior lifecycle tests remain unchanged. This local independent-engine result does not mean the current uncommitted branch passed remote Linux CI. Formatting and diff checks are recorded with the final preservation evidence.

### 9. Preservation and evidence

All pre-existing source hashes and heads were checked: 171 M8G files were unchanged before this report edit; 158 original-checkout and 160 M8-H files remain unchanged. The only pre-existing M8G file deliberately edited in this slice is this report. Dockerfile.distroless is the only added non-ignored file. Both pre-existing Dockerfiles, all tests, application/auth/tenant/domain code, H1/H2 implementation, package graph, migration SQL/metadata, CI and scanner helpers/policy are unchanged. The previous report has a verbatim snapshot.

Docker Desktop preservation checks retained all **30 pre-existing container IDs and 51 volume creation identities**. The independent engine retained both **2 pre-existing containers and 8 volume creation identities**. No persistent PostgreSQL volume was mounted, reset, migrated or deleted. Helpers retired only their invocation-owned resources. The tested images and full reports remain available locally for review. No engine restart/reconfiguration, pruning, unstable package install, suppression, VEX, threshold/freshness reduction, auth bypass, mutation retry, HTTP transport, production deployment, image publication, commit or push occurred.

Primary new evidence: engine-diagnostics.json, selected-desktop-settings.json, independent-engine.json, independent-load.json, linux-source-view.json, trixie-smoke-retry._, distroless-smoke._, final-native-runtime-probes.json, archive-hashes.json, _-filesystem.json, trixie-filesystem-comparison.json, candidate-filesystem-comparison.json, distroless-removed-component-paths.json, triage-current.json, the fourteen vendor HTML snapshots, immutable Node source identities, native disassembly JSON, security-policy-tests.json, final-scans._, source/resource-preservation*.json. The raw full SBOMs/scans/database status/actual exits are in .security-reports/run-796013ea-f9e8-4f00-953e-3197f5183b33. All earlier scan and diagnostic directories remain intact and ignored.

### 10. Remaining blockers and next owner decision

**Release remains blocked.** Distroless has five High advisory IDs with eleven matches; Trixie has fourteen with fifty-four. No supported stable fixed package was identified for the remaining installed-release matches. The Bookworm baseline also retains its prior twenty blocking IDs, including Critical CVE-2026-5450; keeping it as the working baseline is not production approval. The separately compiled bundled-zlib concern persists byte for byte in both experiments. Canonical source/artifact permissions and a clean Linux CI/release-artifact run also remain acceptance work.

Recommended owner decisions, in order:

1. Request Debian/GCC/zlib/Node vendor clarification using the exact versions, binaries, POSIX allocator evidence, OS affected-range disagreement and bundled-writer disassembly. This task did not contact maintainers or submit a disposition on the owner's behalf.
2. Decide whether to wait for supported stable vendor updates or separately authorize reviewed stable backports/official runtime remediation. Unstable package installation and major dependency changes remain unauthorized.
3. Authorize a bounded packaging slice to normalize artifact modes and establish canonical native-Linux reproducibility, then run the complete required CI on the reviewed branch/artifact. Diagnose Desktop with vendor guidance or a controlled backend comparison only under separate approval; do not reset the current engine or its data to obtain a green result.
4. Review distroless as a future candidate after these blockers are resolved. Its verified functionality and smaller genuine component set justify continued review, not promotion or an exception. No vulnerability exception is requested or approved by this experiment.

Stop after this assessment and return it for owner review. M8-G is not marked complete.

## M8-G4 - Final candidate security and artifact review (2026-10-27)

### 1. Acceptance decisions and scope

| Decision                                      | Assessment                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security implementation code-review readiness | Review package prepared: source inventory, native evidence and an unapplied permission proposal are available. This is not reviewer approval.                               |
| CI integration readiness                      | Not established for the current uncommitted branch. Both npm audits and the complete image gate remain mandatory; no bypass or partial green result authorizes integration. |
| Production-release readiness                  | Blocked: five High advisory IDs, bundled Node zlib uncertainty and artifact-permission remediation remain open. No image promotion is authorized.                           |

Only this report is changed by M8-G4. The active Dockerfiles, container helper, application code, dependencies, CI, schemas and migration bytes remain as inspected. The previous report is preserved verbatim in .security-reports/m8-g4-20261027/review-before-m8-g4.md. Experimental permission changes exist only as an unapplied patch and isolated fixtures in that ignored evidence directory. All earlier findings remain blocking.

The original Bookworm Dockerfile remains the accepted functional baseline, with its prior security blockers. Trixie and distroless remain experiments. Local stdio still assumes a trusted OS account and launcher; environment-supplied identity is not independent authentication, production local-auth rejection remains, and runtime database credentials are not protected by RLS.

### 2. Exact distroless artifact, provenance and dependency closure

- Final tested/scanned image config ID: **sha256:daac2f86bda0fbe6076b116fa2a8378c502c37c795f8caaa977a01332b9c03af**.
- Immutable official base index: **gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8**.
- Selected linux/amd64 base manifest: sha256:4d0e659ef1f628c75d9940766cb444fa9605cc190b13676b9e62e1fa567c5cf4.
- Base config: sha256:ec563c6cd18654396f7b506d0b87b0357b741f7b86ad074f1190d8a3380b60a1.
- Retained complete final archive: 189,872,128 bytes, SHA256 **35c2b7b7625996e3aed18957a2e51f8f7bf7b6cb50261b667d09678d14ae884c**. Its current hash equals the scanner's release-2.tar byte for byte.
- Live image config and all 38 ordered root filesystem diff IDs equal the retained full Syft catalog/scan identity. The first 22 diff IDs equal the authenticated base config. Config ID, registry manifest digest and outer tar SHA are distinct identifiers.
- Actual runtime: Node **24.22.1**, OpenSSL **3.5.9**, bundled zlib **1.3.2.1-motley-285e94b**, UID/GID **65532:65532**, ENTRYPOINT /nodejs/bin/node, argument /app/apps/mcp-server/dist/main.js, SIGTERM stop signal. No shell, npm, Yarn or package manager is required in the final stage.

The [published distroless signature procedure](https://github.com/GoogleContainerTools/distroless#how-do-i-verify-distroless-images) was executed against the exact index with Cosign 3.1.4, issuer https://accounts.google.com and identity keyless@distroless.iam.gserviceaccount.com: **exit 0**. Certificate trust, signed claims and bundled transparency-log inclusion were verified; no insecure or skip-verification flags were used. The raw index/amd64 manifest/config were fetched and digest-verified to bind that signature to the actual candidate's base layers. This authenticates the base, not the custom final application image. The latter has no signature or build attestation; the build helper deliberately uses --provenance=false.

Cosign was obtained from its official GitHub release, checked against release API asset SHA256 and published checksums before execution, and used an isolated default-trust TUF cache plus empty Docker credential configuration. Its executable SHA256 is cbe953787074611f1334cbf37dc1cf953995bb8c45398eb4fc7bb781d29c1f2a. Tool bootstrap trust is official GitHub HTTPS metadata/checksums, not an independently pretrusted bootstrap signature. No user credential store or global trust configuration was modified.

Node provenance was independently strengthened: the [official v24.22.1 archive](https://nodejs.org/dist/v24.22.1/) SHA256 6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6 matches SHASUMS256.txt. gpgv verifies its detached signature with release key **5BE8A3F6C8A5C01D106C0AD820B1A390B168D356**, exit 0. The keyring comes from [immutable official release-keys commit 481637f](https://github.com/nodejs/release-keys/tree/481637f813e912c4aa3622d7964ab426c97b8e8d), over HTTPS; that is the explicit trust bootstrap. The archive's 126,879,696-byte Node binary hashes to **e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb**, exactly the shipped executable. This establishes signed-release binary identity, not a reproducible build from the inspected source commit or a vulnerability exemption.

The complete Dockerfile dependency chain remains pinned official Node/Trixie manifests -> full build, and manifests -> production npm closure, followed by the separate distroless final stage. npm ci is lockfile-based, engine-strict and disables lifecycle scripts; the full build compiles TypeScript. The production install uses --omit=dev and the mcp-server workspace and removes the otherwise dangling test-support development link. Only the six used workspaces, production node_modules, compiled artifacts and original migrations enter the image. Shared/test-support manifests are build inputs; their compiled packages, SDK client and dev toolchain are not shipped. Full SBOMs retain installed package relationships; absence of build tools is not proof that compiled native vulnerabilities disappeared. Core versions remain SDK server 2.3.1, Zod 4.6.6, pg 8.23.1, Drizzle 0.45.3 and Pino 10.4.0.

All eleven migration SQL/metadata assets and seven shipped manifests match current source SHA256s. No migration was added or edited. The CA bundle exists, is readable by the runtime user and hashes to e9c7b63ee2623386e9b0a3ee32f499d01a8ea23dc83b8383ddff9f8e749543b7 (222,073 bytes, root:root, 0555). A new no-network/read-only Node probe sees 118 bundled and 296 system CA entries. The retained exact-image smoke tests actually exercised PostgreSQL certificate/hostname verification with a supplied test CA. Certificate presence alone does not prove TLS connection correctness.

No secret is baked into the Dockerfile: runtime configuration supplies protected database credentials, cursor key and the operator's principal. Startup still validates environment, verifies database/schema/privileges before readiness, uses the existing bounded lifecycle/limits, and logs to stderr. Actual protocol-only stdout and all eight tools were verified in the retained exact-image tests.

### 3. Permission root cause and actual runtime impact

The issue combines **B, C, D and E**: platform-dependent build inputs affect reproducibility; those modes survive export/import and permit real runtime writes; the read-only smoke harness prevents writes and therefore masks the DAC weakness. It is not merely tar/OCI numeric representation (**A**).

Git records these 18 files as 100644. Windows fs.stat presents virtual 0666 bits; Windows Docker context export produced 0755 in the earlier artifact. WSL's /mnt/c view presents the same source files as 0777, owned by 1000:1000. The helper's native Linux snapshot preserves file modes while creating traversable directories. Final COPY preserves these file bits and defaults ownership to root:root. Thus the Windows-produced Trixie archive has these files at root:root 0755, and the current Linux-produced Trixie/distroless archives have root:root 0777. All 8,571 compared Trixie paths retain identical contents/types/links; these 18 modes account for the cross-host layer/config difference.

The exported archive's 0777 modes exactly match stat in the independently imported image. New direct, non-truncating open(path, 'r+') probes as UID/GID 65532:65532 succeed for every affected file without --read-only; the same opens return EROFS with --read-only. No payload bytes were written. A compiled main.js control is root-owned 0644 and denies the direct open with EACCES. Migration directories and other inspected parent directories are root-owned 0755; /app itself is 65532:65532 0755.

Affected files (all eighteen; no dependency/native/compiled-file normalization is proposed):

- package.json
- apps/mcp-server/package.json
- packages/domain/package.json
- packages/application/package.json
- packages/database/package.json
- packages/infrastructure/package.json
- packages/mcp/package.json
- packages/database/migrations/0000_tenancy_foundation.sql
- packages/database/migrations/0001_project_knowledge.sql
- packages/database/migrations/0002_evidence_search.sql
- packages/database/migrations/0003_opportunities.sql
- packages/database/migrations/0004_project_note_audit.sql
- packages/database/migrations/meta/0000_snapshot.json
- packages/database/migrations/meta/0001_snapshot.json
- packages/database/migrations/meta/0002_snapshot.json
- packages/database/migrations/meta/0003_snapshot.json
- packages/database/migrations/meta/0004_snapshot.json
- packages/database/migrations/meta/_journal.json

| Path class                                                               | Tested Linux candidate                                           | Earlier Windows artifact | Proposed artifact                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------ | -------------------------------------------------- |
| Seven manifests + eleven migration assets                                | root:root 0777; direct write-open allowed without read-only root | root:root 0755           | root:root 0644; direct write-open must fail EACCES |
| Migration root and meta directories                                      | root:root 0755                                                   | root:root 0755           | root:root 0755, explicitly retained                |
| Other existing directories, compiled code, node_modules and native files | Existing owners/modes                                            | Existing owners/modes    | Unchanged                                          |
| /app                                                                     | 65532:65532 0755                                                 | Existing artifact mode   | Unchanged; read-only root remains mandatory        |

**Important limit:** even after this file-only fix, runtime-owned /app can permit replacement of top-level entries on a writable root filesystem. Restricting direct file opens does not make the whole tree immutable. The proposal deliberately does not change unrelated directory ownership; accepting a writable-root deployment would require separate owner-approved directory/ownership review. Continue requiring --read-only, dropped capabilities and no-new-privileges.

### 4. Narrow proposal and focused regression evidence

The concrete, **unapplied** proposal is .security-reports/m8-g4-20261027/permission-normalization.patch. It changes only Dockerfile.distroless and scripts/container-smoke.ts if later approved/applied. git apply --check succeeds.

It adds a build-derived runtime-artifacts stage. A single targeted chmod 0644 names the seven shipped manifests and the migration SQL/meta JSON file globs, followed by chmod 0755 on the two migration directories. Final COPY sources only those assets from that stage. No chmod -R, chown, runtime shell, dependency upgrade, database change or other file-mode normalization is included. Runtime compiled code and node_modules still come from their existing stages; all copied file bytes must remain equal.

The proposed helper regression inspects exactly those files at root:root 0644 and opens them r+ expecting EACCES as the nonroot runtime user. That isolated, network-disabled metadata probe intentionally omits --read-only to test file permissions themselves; all application/MCP sessions retain --read-only. It also checks traversable root-owned parent directories, original migration hashes and the existing dependency/artifact invariants.

The first proposed approach, final COPY --chmod=0644, was **rejected by a real fixture**: BuildKit also created destination migration directories at 0644. That proposal, archive and failure are preserved as attempt-1 evidence. It was never applied to the candidate or active files.

Four revised native-Linux BuildKit fixtures (original/normalized, source 0755/0777) now pass. They use the same pinned official build base, a private bounded builder, no network during RUN, scratch final stages and exported archives only; no final release candidate was rebuilt/imported. Each verifies eighteen modes, root ownership, exact source hashes, migration directory traversal and an unrelated 0640 control. Both normalized inputs produce identical config **sha256:527d5dbb8f55b38cb3f9d6c568cc54293b99de02a54eb31051c9a17582ba5c64**; original 0755/0777 inputs differ. This proves the targeted fixture behavior, not complete cross-host application reproducibility. The proposed full-image permission regression is prepared but has not run against a normalized complete candidate, because no such candidate is built or approved here.

### 5. Five-CVE evidence matrix

Every row remains **High and blocking**. Scanner fixes are empty for the installed stable release; vendor no-dsa and scanner wont-fix are triage labels, not proof of inapplicability. Current Debian pages were checked again on 2026-10-27; the existing valid full-image scan is retained.

| Advisory                                                                       | Exact installed packages and scanner state                                        | Native evidence and application-path limit                                                                                                                                                                                                                                                                                                                                                                     | Vendor status and supported remediation                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CVE-2026-102010](https://security-tracker.debian.org/tracker/CVE-2026-102010) | gcc-14-base, libgcc-s1, libgomp1, libstdc++6, each 14.2.0-19; 4 matches; wont-fix | PBDS binary-heap priority-queue erase_if stale-pointer/use-after-free. libstdc++ is loaded; template instantiation in optimized Node/native code remains unresolved. Missing compiler headers and source-package matches prove neither absence nor reachability.                                                                                                                                               | Trixie gcc-14 vulnerable/no-dsa. Fixed gcc-14 14.4.0-3 is in forky/sid, not an identified supported Trixie update. Request vendor/build-specific clarification; wait for a supported stable correction or separately reviewed vendor backport.                      |
| [CVE-2026-19499](https://security-tracker.debian.org/tracker/CVE-2026-19499)   | libc6 2.41-12+deb13u4; 1 match; wont-fix                                          | strfmon/strfmon_l right-padding output overflow. The exact loaded libc exports both implementations. No V1 caller or attacker-controlled formatting path was demonstrated; presence of libc is not proof that a tool reaches strfmon.                                                                                                                                                                          | Trixie vulnerable/no-dsa; first fixed unstable source version 2.43-5 (current 2.43-7). No supported stable fixed package identified. Preserve blocker pending stable update/vendor assessment.                                                                      |
| [CVE-2026-5435](https://security-tracker.debian.org/tracker/CVE-2026-5435)     | libc6 2.41-12+deb13u4; 1 match; wont-fix                                          | Deprecated DNS presentation routines ns_printrrf/ns_printrr/fp_nquery and TSIG formatting. Distroless actually contains libresolv.so.2, hash d41dd4adacf5a35df426461dd8a92d7bdd5ba29bb61a1c3531bec0ada386f8dd; __fp_nquery and related formatting symbols are present. Ordinary resolution is not evidence of this presentation API call. A tool-to-corrupting-TSIG path is unproven.                          | Trixie vulnerable/no-dsa; first fixed unstable source version 2.43-3 (current 2.43-7). No supported stable correction identified. Removing libc-bin does not remove libc6/libresolv code.                                                                           |
| [CVE-2026-85091](https://security-tracker.debian.org/tracker/CVE-2026-85091)   | zlib1g 1:1.3.dfsg+really1.3.1-1+b1; 1 match; not-fixed                            | OS libz is present, hash 85590dd58edf5445e18bc7193e5ebc01ac5841f1ae187e97705a662e90c6421e. Old OS writer behavior differs from retryable bundled Node code. Upstream affected-range disagreement remains unresolved; see separate bundled analysis below. No corrupting MCP input is reproduced.                                                                                                               | Stable vendor entry remains vulnerable; sid fixed 1:1.3.dfsg+really1.3.2-4. No stable fix or vendor-approved inapplicability established. Need separate OS range adjudication and Node correction/adjudication; an OS replacement does not repair static Node code. |
| [CVE-2026-95619](https://security-tracker.debian.org/tracker/CVE-2026-95619)   | gcc-14-base, libgcc-s1, libgomp1, libstdc++6, each 14.2.0-19; 4 matches; wont-fix | Aligned operator-new size rounding. Exact loaded libstdc++ hash 972bb2a18b71140dab0240f8a1f68ab3fb1d56bcd4c4f824a91b70888faf5a00; imported aligned array-new delegates to scalar aligned-new, which calls posix_memalign. Upstream distinguishes this backend from affected rounding backends: evidence supports a build-specific applicability dispute, not clearing all GCC matches or all overloads/builds. | Trixie vulnerable/no-dsa; gcc-14 14.4.0-3 fixed in forky/sid only. Obtain vendor/build-specific disposition or supported stable update. Do not install unstable packages to clear a package match.                                                                  |

The exact libc hash is 9792e3cbb541c8f44c7acf5f14f4022ea62998ecc787d326bed4d8b6547dfd92. New symbol inspection confirms monetary-format and resolver code presence in the same binaries as distroless. The extra libgomp1 source-package matches are retained even though libgomp is not in the observed initial Node library map; this does not mean it implements the PBDS/allocator flaw. No complete optimized native call graph, exploit attempt or vendor-approved exclusion is claimed. Supported stable fixes were not found in the current tracker; unstable fixed versions are recorded as evidence, not installation recommendations.

### 6. Bundled Node zlib: four separate evidence levels

**Source:** immutable Node commit ce7aaf1cee78b8cf0ce17364260535c418d3ed26 contains the retryable gzwrite implementation. Its gzwrite.c hash is 2ce783294c688330c716bfe106f43167d3dae5be84994176bc304d205d4f5b04. The upstream [nonblocking introduction 81cc0beb](https://github.com/madler/zlib/commit/81cc0bebedd935daeb81b0b6e475d8786b51af3d) and [correction df84af25](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148) establish the relevant change: resetting avail_in/next_in before returning from a stalled direct external-buffer write. The inspected Node source lacks that correction.

**Binary:** the now signed-release-identified Node binary contains that pre-fix error-return pattern: gzwrite -> gz_write 0x1a27790; the 0x1a278dd-0x1a2790c branch omits those resets. gzvprintf contains the inlined vacate/memmove flow. Missing standalone gz_vacate symbols do not mean missing code. This is stronger than a version-string inference, but not a fully reproduced source build.

**Exploitability:** the described trigger combines a nonblocking gz-file handle, external-buffer write stall and subsequent gzprintf/gzvprintf. Inspected Node JS zlib bindings use deflate/inflate, not gz-file APIs. No V1 tool exposes arbitrary FFI/subprocess calls, and no .node add-on exists in the inspected complete application tree. These restrict the observed path; they do not prove the whole optimized runtime cannot reach it. No exploit or memory-corrupting MCP input was demonstrated.

**Vendor/fix:** the [current official Node release index](https://nodejs.org/dist/index.json) lists 24.22.1 as the latest 24.x release. No newer compatible official Node 24 security fix or Node vendor adjudication of this native path was identified. The Node release notes' security flag is not an advisory-specific determination. Debian's old OS version remains marked vulnerable despite the upstream 1.3.1.2-through-1.3.2 range; [upstream issue 1310](https://github.com/madler/zlib/issues/1310) records that disagreement. Keep both the OS match and separate bundled concern unresolved. Do not add an invented extra scanner ID, claim universal non-exploitability, patch native code locally or replace stable libraries with sid packages.

### 7. Security controls and unchanged release gate

Source review confirms that CI still enforces the production dependency wrapper **and** full npm audit --audit-level=high --strict-ssl=true. The container job builds/tests the complete default Bookworm release image, runs real security-enforcement fixtures and then scans that exact final artifact. No continue-on-error, ignore/VEX exception, only-fixed filter or reduced threshold is introduced. Trixie/distroless are not silently substituted into default CI.

The security wrapper distinguishes scanner/provisioning/time-limit failures from policy findings, rejects malformed reports or inconsistent exit codes, validates config identities/ordered layers and requires full OS plus installed runtime dependency catalogs. Grype requires hash-verified, valid database age <=120 hours, an update check and High/Critical failure. Future-dated databases beyond the permitted clock skew fail closed. Existing security-policy regressions and retained real enforcement fixtures cover these failure boundaries. Tests do not guarantee the vulnerability database itself is complete or that every statically bundled component is cataloged.

Current unchanged image evidence:

| Candidate              | Unique blocking IDs | High matches | Critical matches | Actual Grype exit | Wrapper exit / classification |
| ---------------------- | ------------------: | -----------: | ---------------: | ----------------: | ----------------------------- |
| Trixie a746ab3d...     |                  14 |           54 |                0 |                 2 | 1 / vulnerability_policy      |
| Distroless daac2f86... |                   5 |           11 |                0 |                 2 | 1 / vulnerability_policy      |

The 2026-10-27 full final-image run is .security-reports/run-796013ea-f9e8-4f00-953e-3197f5183b33. Its database is valid schema v6.1.10, built 2026-10-27T06:30:41Z, downloaded archive SHA256 16a9163729d925edbf911db3542666748f06ddb2ce541211a4f1314349e20442. No release candidate changed and this evidence remains within the configured freshness window at review time; no new expensive image scan was justified. A later acceptance run must recheck freshness and update availability.

Five scanner/update logs were inspected for credential-bearing PostgreSQL URLs, assigned secret variables and private-key markers; none matched. Scanner input is public artifact/build metadata, not runtime configuration. This bounded pattern review is not universal secret-redaction proof. Raw logs remain ignored evidence, should not be indiscriminately published, and existing wrapper diagnostics remain bounded and sanitized.

No MCP schema, explicit eight-tool registration, trusted context resolver, authorization decision, tenant SQL predicate, mutation transaction or idempotency contract changes in this review. The existing logging change emits one invocation record: info for success, warn for expected failures including RATE_LIMITED, error for INTERNAL_ERROR. Sink exceptions are contained. The signing-key validation is shared between startup and codec and rejects structurally weak values; it does not measure entropy. Changing an existing weak key can invalidate cursors and requires protected CSPRNG key configuration. Logger redaction covers the configured shapes/depth, not arbitrary secret nesting.

### 8. Sanitized source-review inventory

All **39** existing changed files are included below, grouped once. The machine inventory stores path, git status and SHA256 only, not environment contents or payloads. Its pre-report hashes are retained in changed-file-inventory.json. The newly prepared patch/diagnostics are ignored evidence, not applied source changes.

#### A. Security logging and validation (6)

- .env.example (modified)
- packages/infrastructure/src/environment.ts (modified)
- packages/infrastructure/src/logger.ts (modified)
- packages/infrastructure/src/signed-cursor.ts (modified)
- packages/infrastructure/src/signing-secret.ts (untracked)
- packages/mcp/src/server.ts (modified)

#### B. Dependency security fixes (6)

- package.json (modified)
- package-lock.json (modified)
- packages/application/package.json (modified)
- packages/database/package.json (modified)
- packages/infrastructure/package.json (modified)
- packages/mcp/package.json (modified)

#### C. Scanner and CI infrastructure (7)

- .github/workflows/ci.yml (modified)
- .github/dependabot.yml (untracked)
- .gitignore (modified)
- scripts/security-check.ts (untracked)
- security/grype.json (untracked)
- security/toolchain.json (untracked)
- tsconfig.check.json (modified)

#### D. Container image changes (4)

- Dockerfile (modified)
- Dockerfile.trixie (untracked)
- Dockerfile.distroless (untracked)
- scripts/container-smoke.ts (modified)

#### E. Tests (9)

- apps/mcp-server/test/lifecycle.test.ts (modified)
- apps/mcp-server/test/main.test.ts (modified)
- packages/infrastructure/test/environment.test.ts (modified)
- packages/infrastructure/test/logger.test.ts (modified)
- packages/infrastructure/test/signed-cursor.test.ts (modified)
- packages/infrastructure/test/signing-secret.test.ts (untracked)
- packages/mcp/test/invocation-limits.integration.test.ts (modified)
- packages/mcp/test/server.test.ts (modified)
- packages/test-support/test/security-policy.test.ts (untracked)

#### F. Documentation (7)

- README.md (modified)
- docs/architecture.md (modified)
- docs/implementation-plan.md (modified)
- docs/local-stdio-container.md (modified)
- docs/m8-g-reconciliation-spec.md (untracked)
- docs/m8-g-security-review.md (untracked)
- docs/security.md (untracked)

Groups A, B, C, E and the accurate documentation are independently useful: safe invocation severity/redaction, shared key validation, compatible dependency patches and fail-closed CI/scanner coverage do not depend on promoting a new image. Group D remains candidate packaging work requiring explicit review. Independently useful does not mean independently mergeable without required CI: preserve all gates, run the reviewed branch's full checks and obtain reviewer/owner acceptance. Splitting a review cannot be used to skip the still-red image job. Dependency updates remain patch-level Zod 4.6.5 -> 4.6.6 and Vite override 8.3.2 -> 8.3.3; no unreviewed major change is proposed.

### 9. New verification and reused evidence

New evidence is confined to .security-reports/m8-g4-20261027 plus the production audit wrapper's own run directory:

- Distroless index signature: exit 0; index/manifest/config/layer binding verified.
- Official Node detached checksum signature: exit 0; official archive checksum and shipped binary match.
- Exact live image/config/38-layer binding and byte-identical full scanner archive: passed.
- Eighteen current artifact hashes and eleven original migration assets: matched.
- Actual candidate permission probes: eighteen successful direct write-opens without read-only root; eighteen EROFS with it, as nonroot; payloads unchanged.
- First COPY --chmod fixture: failed the directory-traversal assertion; rejected and retained.
- Four revised targeted packaging fixtures: passed; identical normalized config across differing source modes, root ownership and file contents preserved; unrelated mode unchanged.
- Concrete unapplied two-file patch: git apply --check exit 0. No normalized complete release image was built.
- Read-only/no-network runtime CA/native-version probe and native monetary/resolver symbol inspection: passed.
- Production dependency wrapper audit: exit 0, zero reported vulnerabilities; full npm audit: exit 0, zero reported vulnerabilities. These do not clear native OS/bundled findings.
- Fresh npm run verify: exit 0; formatting, lint, strict typecheck/build and all **511 tests in 22 files passed**, including logging and security-policy regressions. Final report formatting/diff and preservation checks are retained separately.

Reused, not newly claimed: 511 non-integration tests and 441 PostgreSQL integration tests with three Windows platform skips, original migration integrity/generation checks, the retained real security enforcement proofs, both M8-G3 exact-image cold rebuild/runtime suites (Trixie exit 0, distroless exit 0), all eight tools, verified PostgreSQL TLS/readiness, note/audit same-key idempotency, protocol-only stdout and signal/EOF cleanup. The latest unit verification is distinguished in the final command evidence. No fresh PostgreSQL suite, full application rebuild or full image rescan is needed for this report/unapplied-proposal review. A later applied packaging change must rerun full artifact/runtime/security checks, including the new permission regression.

### 10. Remaining blockers and recommended owner decision

1. Review the concrete permission patch and its exact file/directory behavior before authorizing application. Retain mandatory read-only runtime protection; decide separately whether a writable-root deployment is ever supported, since /app remains runtime-owned. After an approved application, rebuild/reproduce the complete candidate and rerun its full runtime, migration, protocol and security gates.
2. Seek Debian/GCC/zlib/Node vendor adjudication with exact hashes, allocator backend, OS range disagreement and bundled pre-fix writer evidence; alternatively wait for supported stable fixes. No maintainer was contacted on the owner's behalf. No native custom patch, unstable package, suppression or release exception is authorized.
3. Review code independently of deployment acceptance. Current remote CI for this uncommitted branch is not established; the High/Critical image gate is deliberately still red. A future release also needs approved candidate selection and final artifact provenance/signing policy.
4. Keep Bookworm as the functional baseline and distroless/Trixie as experiments until those decisions and all required checks are satisfied. No release image, tag or deployment is promoted.

Final preservation checks compared all 172 pre-existing M8G source files: only this report differs, and HEAD/branch are unchanged. All 158 original-checkout files and 160 M8-H files match their starting hashes. Docker Desktop retains all 30 containers and 51 volume creation identities; independent Ubuntu retains both containers and all 8 volume creation identities. Only invocation-owned temporary probe containers/builders were retired. No existing data volume was mounted or changed, no engine was restarted, and all prior reports/archives remain intact. Final whole-repository formatting, git diff --check and the unapplied-patch check each exit 0.

The report distinguishes demonstrated file write access and compiled pre-fix code from an unproven application exploit. Neither successful functional tests, fewer packages, a valid base signature nor vendor no-dsa overrides the security policy. M8-G remains incomplete. No commit or push is made.

## M8-G5 - Permission-remediation preflight (2026-10-27)

Historical preflight record: the owner subsequently approved the additional /app ownership change. The implementation and completed verification below supersede this stop condition.

**Incomplete; stopped before applying the patch.** The request authorizes the eighteen regular files at 0644 and explicitly says to stop if the proposal affects additional paths. Its replacement-protection requirement exposes the previously documented /app ownership gap. Approval to change that additional directory is pending; neither the eighteen-file patch nor the proposed directory extension has been applied.

Fresh inspection on the independent Ubuntu engine confirms all eighteen paths listed in M8-G4 section 3 are regular files, root:root, mode 0777, link count one, with no symlink components or hardlink aliases. Every content hash matches the retained candidate/source record. These are seven JSON package manifests, five SQL migration files and six migration JSON assets, consumed as data; none is a direct executable entrypoint. The actual executable is /nodejs/bin/node, root:root 0555; the compiled main.js remains Node-interpreted. M8-H migration/readiness code reads the committed migration folder; no asset needs an executable bit. No application file content or mode has changed.

Parent inspection identifies /app as 65532:65532 0755, while the other target ancestors are root-owned traversable directories. The preserved file-only proposal leaves /app unchanged. New disposable-container probes, with no network/capabilities and otherwise writable roots, give:

| Probe                                         | UID/GID 1000:1000 | Actual runtime UID/GID 65532:65532                                  |
| --------------------------------------------- | ----------------- | ------------------------------------------------------------------- |
| Write access to /app                          | Denied            | Allowed                                                             |
| Rename /app/package.json and restore          | EACCES            | Allowed                                                             |
| Rename /app/apps or /app/packages and restore | EACCES            | EXDEV on this overlay filesystem; no broader rename success claimed |
| Same rename probes with read-only root        | EROFS             | EROFS                                                               |

All eighteen hashes are unchanged after the reversible, invocation-owned container probes. No existing container or image was modified. A file's 0644 bits do not prevent its directory owner renaming/unlinking its directory entry. Thus UID 1000 protection alone would not prove protection for the actual runtime account. The file-only change cannot satisfy a general no-replacement claim on an otherwise writable root.

A concrete **unapplied** scope extension is retained at .security-reports/m8-g5-20261027/app-owner-extension.patch; git apply --check exits 0. It selects USER 0:0 before creating WORKDIR /app in the release build stage, with the existing final USER 65532:65532 unchanged. The requested additional filesystem delta is only /app ownership 65532:65532 -> root:root, retaining 0755 and traversal. The extension needs owner approval and a complete rebuilt-filesystem comparison to verify that exact scope; no shell is added to distroless. An approval request explicitly identifies this additional path and the M8-G5 scope restriction.

The retained application filesystem inventory has exactly eighteen group/world-writable regular files, matching the targets. No new permission regression has been added to the active helper yet. The prepared M8-G4 helper also needs its writable-root probe reconciled with its existing /app write-refusal assertion; it must not be applied blindly.

Evidence: .security-reports/m8-g5-20261027/before.json, target-preflight.json (all paths, types, owners, modes, inode/link counts, real paths, parent access and SHA256s), parent-replacement-preflight.json, writable-application-files-before.json, and the unapplied extension/check. The pre-M8-G5 report is retained verbatim. Only this report is intentionally edited; original M8-G/M8-H implementation and historical scanner evidence remain preserved.

No corrected image or new image identity exists yet. Cold rebuild, full packaged protocol/PostgreSQL TLS/idempotency/signal checks, M8-H integration compatibility and a fresh complete-image scan have **not** been executed in M8-G5. No new Grype exit or database timestamp is claimed. The previous candidate remains sha256:daac2f86bda0fbe6076b116fa2a8378c502c37c795f8caaa977a01332b9c03af. Its retained five blocking IDs (CVE-2026-102010, CVE-2026-19499, CVE-2026-5435, CVE-2026-85091 and CVE-2026-95619), and separate bundled Node zlib uncertainty, are not resolved by this preflight.

**Decision required:** approve the additional root ownership of /app, keeping 0755 and nonroot final execution, then continue the bounded remediation and complete artifact/runtime/security verification; or retain the strict eighteen-file scope and stop with the replacement-protection limitation. Implementation/source-review acceptance for M8-G5 is not established, and CI/release gates remain mandatory. No migration, authentication/tool/domain change, suppression, image publication, promotion, commit or push has occurred.

## M8-G5 - Implemented permission remediation and verification (2026-10-27)

### 1. Scope and owner approval

The owner explicitly approved **root:root ownership for /app, retaining 0755**, in addition to the eighteen-file 0777 -> 0644 normalization. Permission remediation is implemented and locally verified; this is **not production-release authorization**. The preceding preflight and all historical scanner/triage records remain preserved.

Only three source files change in this slice:

- Dockerfile.distroless: a build-derived runtime-artifacts stage normalizes the seven shipped manifests and eleven original migration assets. Only those artifacts are copied from that stage. Two migration directories retain 0755. No blanket chmod -R or chown is used.
- scripts/container-smoke.ts: adds four distroless-only packaged permission cases for UID/GID 1000:1000 and 65532:65532, with writable and read-only roots. Existing artifact checks remain read-only; all MCP sessions still use read-only roots.
- docs/m8-g-security-review.md: this implementation, verification and security-gate record.

The release stage selects USER 0:0 before WORKDIR /app so that directory is created root-owned. It has no RUN command or shell dependency. The final USER remains **65532:65532**, and the actual MCP runtime remains nonroot. Node's entrypoint, environment defaults, module resolution and shutdown signal are unchanged. Production dependencies and compiled artifacts continue using the original stages; the complete package inventory is identical.

### 2. Exact permission changes and content integrity

All eighteen corrected paths below are regular files, root:root, link count one, without symlink components. Their modes change from **0777 to 0644**; their contents are unchanged. JSON manifests, migration SQL and migration JSON are read as data, so none requires direct execution. The actual Node executable retains its original executable bits and hash.

| Corrected path                                                | Unchanged SHA256                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| /app/package.json                                             | a1d3fb63f5bf56cd1f60681d207e2b454dd687534a4e7eef8fb475e3e280bc8c |
| /app/apps/mcp-server/package.json                             | 5f66fef4069dc7feb356a52ae5f68cb2a1575f5da185cd2a23342597735c9a05 |
| /app/packages/domain/package.json                             | 4bcc889f752ad1fff06a8959a7d3801add3687cb3da8029b13d78fba2c94adbb |
| /app/packages/application/package.json                        | 75f8733f89b4872d5c7ab8bb4e763b279ffa722ee063db0927f625422aa14bd3 |
| /app/packages/database/package.json                           | 605b5d5635d3341d3761aa1b7a10d3f8718f88859d7bd74b6eec6fcfd4fb2f91 |
| /app/packages/infrastructure/package.json                     | 12e9586768ddffa1928c15905b0279cab1f0d2a796ef3c708ed43674d1b6c4af |
| /app/packages/mcp/package.json                                | 164f3af2787c88be4385a2f9fd473199b1eac06732efe691a4d97612cb367a63 |
| /app/packages/database/migrations/0000_tenancy_foundation.sql | 3d14e850caf1518cbb411952bfd13612a6bca6276d6797f2eae31686cc49e886 |
| /app/packages/database/migrations/0001_project_knowledge.sql  | ae94471ef42de49b671144f475b3a262b256706ec24c2b638f947fbe3c26caf3 |
| /app/packages/database/migrations/0002_evidence_search.sql    | ea24c0f8e76dd656325db506e4bdb867f4b3362dd2d7e84ffa77f8a99b029c69 |
| /app/packages/database/migrations/0003_opportunities.sql      | cc7c5d66a4e6b2daf305379b21c02d96005fdc691333b9119df468f304655bec |
| /app/packages/database/migrations/0004_project_note_audit.sql | 6618bc924252d239523c8f15529ab4dd9b5c256a2d4b7d5f7717c1b5efb24fac |
| /app/packages/database/migrations/meta/0000_snapshot.json     | 9bdf3f8161bf9dcc5404494ebacb4b99b4888d61e0446138c1ef4c427d3186ca |
| /app/packages/database/migrations/meta/0001_snapshot.json     | 5da77fd746d2b7ba358bce32a17c7d3adc9cd181307f45ab1d057f98f01b6ced |
| /app/packages/database/migrations/meta/0002_snapshot.json     | 9e2959eaabbbdf485aaa589be762e374a78bb12c627e4bdff456c8512ed30f48 |
| /app/packages/database/migrations/meta/0003_snapshot.json     | 2735df85ba95ad73139734e005dd5e9d0dd833bd8dc037541b896eee749910ef |
| /app/packages/database/migrations/meta/0004_snapshot.json     | 7ce84feaedec9a7731103e4dfc0f546aa97791f60cec761255f213902609aded |
| /app/packages/database/migrations/meta/_journal.json          | bd78024684f7f9cc65222ccd0be6266e0eee4d764a8d4a8030a4eb8b996c241a |

The only additional filesystem change is **/app UID/GID 65532:65532 -> 0:0**, retaining mode **0755**. All target ancestor directories remain root-owned, traversable and non-writable to either tested nonroot identity.

A full archive comparison checks **6,452 filesystem paths**. Path sets, every file's contents, types, links, sizes, executable modes on other files and all unrelated ownership/modes are identical. It finds exactly eighteen mode changes plus the single directory ownership change; no other filesystem delta is accepted. All eleven migration assets are byte-identical. Machine evidence is filesystem-comparison.json, permission-results.json and the complete before/after filesystem inventories.

### 3. Repeatable filesystem security regressions

The unchanged independent Ubuntu engine ran the new packaged cases:

| UID/GID     | Root filesystem | All 18 readable and hashes matched | Write-open and file rename/replacement refused | Root-owned ancestors non-writable |
| ----------- | --------------- | ---------------------------------- | ---------------------------------------------- | --------------------------------- |
| 1000:1000   | Writable        | Passed                             | EACCES                                         | Passed                            |
| 1000:1000   | Read-only       | Passed                             | EACCES or EROFS                                | Passed                            |
| 65532:65532 | Writable        | Passed                             | EACCES                                         | Passed                            |
| 65532:65532 | Read-only       | Passed                             | EACCES or EROFS                                | Passed                            |

Each test lstat-checks regular type, root ownership, 0644, link count one, real path and content SHA256. It attempts a non-truncating r+ open and a reversible rename to a unique sibling name, requires refusal, then rechecks the content hash. Every ancestor through / is checked for root ownership, traversal and no write access. This closes the demonstrated preflight replacement of /app/package.json by runtime UID 65532.

The helper also traverses /app: all **4,436 regular files** have no group/world write bit in every case. Symlink permission bits are not treated as regular-file permissions. The actual Node binary remains executable, and the original module/artifact checks and full application launch pass.

Writable-root containers are isolated test probes only. Supported application launches continue requiring --read-only, dropped capabilities and no-new-privileges; this task does not authorize a different deployment model.

### 4. New artifact and cold-build/runtime verification

Corrected final image **config ID**:

sha256:3cdae4c823875ad8609452940aac37cc4ced598c6cd78a9ecce32c8ea974c080

This is a local immutable config identity, not a published registry manifest. No image is published. The previous config sha256:daac2f86bda0fbe6076b116fa2a8378c502c37c795f8caaa977a01332b9c03af remains available.

The official pinned base remains gcr.io/distroless/nodejs24-debian13:nonroot@sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8. All first twenty-two signed-base filesystem layers match the prior verified base. Node remains 24.22.1. No base image, npm dependency or native library is changed.

The full exported archive is **189,872,128 bytes**, SHA256 **85e1709bd9e528bf2cf3ee9de0c90eec91f332b4152bc511b7265b08a4f25a24**. Its hash equals the scanner's archive copy. The live image config and every ordered filesystem layer match the new complete SBOM identity; its 56 packages are unchanged: 41 npm, 14 Debian and one binary entry.

The source-only packaged helper built the corrected image and repeated with --no-cache, SOURCE_DATE_EPOCH=0 and timestamp rewriting. Both builds have the exact same config ID. Reproducibility is demonstrated on the tested native-Linux snapshot/engine, not claimed universally across hosts or architectures.

The complete helper exits **0**, in **820,299 ms**, after checking all eight tools, initialization/discovery, protocol-only stdout, verified PostgreSQL TLS, readiness, original migration assets, note/audit same-key idempotency, EOF/SIGINT/SIGTERM cleanup, nonroot execution, six safe startup rejections and no application listeners. The temporary USER 0 build metadata does not become runtime execution. Existing M8-C/M8-D/M8-E behavior and all eight contracts remain unchanged.

### 5. Application and M8-H compatibility verification

npm run verify:all exits **0** and includes:

- npm run verify: formatting, ESLint, strict typecheck/build and **511 passing tests in 22 files**.
- npm run db:check: migration metadata passes.
- Real PostgreSQL integration: **441 passed, 3 Windows platform skips, 18 files**. This includes packages/database/test/migrate.integration.test.ts and packages/mcp/test/recovery.integration.test.ts, with actual backup/restore drill events.

The suite uses a new invocation-owned PostgreSQL 18 container backed by tmpfs and generated credentials; it never selects an existing application database or data volume. The existing PostgreSQL 18 native client tools are used for M8-H2. Test cleanup removes only the invocation-owned fixture. M8-H source, migration bytes, administrative credential separation, ledger integrity and recovery logic are unchanged. The three Windows skips are not represented as native Linux administrative-signal tests; new Linux signal verification here covers the packaged MCP process.

The production dependency wrapper and full npm audit both exit **0**, each reporting zero vulnerabilities. This says nothing about clearing native OS or bundled-runtime findings. Final formatting and git diff --check are recorded with the preservation evidence; documentation-only completion edits do not require repeating the application suite.

### 6. Fresh complete-image scan and unchanged blockers

The scanner uses the exact new complete image, not an old tag, source-only catalog or reduced inventory. Reports are retained at:

.security-reports/run-1589230c-c7ac-49e4-b6a4-40d98c7b194d

The unchanged pinned Syft 1.54.1 / Grype 0.120.1 policy provisions a fresh disposable database cache, verifies the database hash, checks updates and retains the <=120-hour age limit. Database **v6.1.10** is valid and built **2026-10-27T06:30:41Z**; downloaded database archive SHA256 is **16a9163729d925edbf911db3542666748f06ddb2ce541211a4f1314349e20442**.

| Candidate             | Packages | Total matches | High matches | Critical matches | Unique blocking IDs | Grype exit | Wrapper exit |
| --------------------- | -------: | ------------: | -----------: | ---------------: | ------------------: | ---------: | -----------: |
| Previous daac2f86...  |       56 |            31 |           11 |                0 |                   5 |          2 |            1 |
| Corrected 3cdae4c8... |       56 |            31 |           11 |                0 |                   5 |          2 |            1 |

Every advisory/package/version/severity/fix-state match is unchanged. The fresh wrapper result is **vulnerability_policy**, not an operational scanner failure. The run completed in **609,505 ms**. No suppression, VEX, ignored/unfixed exclusion, severity exception, reduced freshness limit or gate bypass was introduced.

| Remaining advisory | Installed package(s)                                    | High matches | Scanner state                        |
| ------------------ | ------------------------------------------------------- | -----------: | ------------------------------------ |
| CVE-2026-102010    | gcc-14-base, libgcc-s1, libgomp1, libstdc++6: 14.2.0-19 |            4 | wont-fix; no fixed version reported  |
| CVE-2026-19499     | libc6: 2.41-12+deb13u4                                  |            1 | wont-fix; no fixed version reported  |
| CVE-2026-5435      | libc6: 2.41-12+deb13u4                                  |            1 | wont-fix; no fixed version reported  |
| CVE-2026-85091     | zlib1g: 1:1.3.dfsg+really1.3.1-1+b1                     |            1 | not-fixed; no fixed version reported |
| CVE-2026-95619     | gcc-14-base, libgcc-s1, libgomp1, libstdc++6: 14.2.0-19 |            4 | wont-fix; no fixed version reported  |

All five remain blocking. Earlier vendor/native applicability disagreements remain unresolved; permission changes do not adjudicate them. The scan/update logs contain no credential-bearing PostgreSQL URL or private-key marker under the bounded pattern review; that is not a universal redaction guarantee.

### 7. Bundled Node zlib and remaining risks

The full content comparison proves the Node executable and native libraries are byte-identical to M8-G4. Node SHA256 remains e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb, with bundled zlib 1.3.2.1-motley-285e94b. Its previously inspected compiled pre-fix writer pattern is not repaired by chmod or directory ownership. No corrupting MCP call path or Node vendor disposition is established; an OS zlib fix would not fix this bundled copy. Both the OS match and separate bundled uncertainty remain open.

The corrected image remains experimental. Local stdio still trusts the OS account, protected environment and launcher; no independent authentication, HTTP listener, OAuth, RLS or production-auth bypass is introduced. Final custom-image signing/attestation and release acceptance remain outside this authorization. The original Bookworm functional baseline and Trixie experiment are unchanged. Current remote Linux CI is not claimed for this uncommitted branch.

### 8. Source review, preservation and next decision

| Decision                     | Current assessment                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| M8-G5 permission remediation | Implemented and locally verified, including replacement protection for the actual runtime UID                |
| Source review                | Bounded three-file change and full artifact/test evidence prepared for review; no reviewer approval inferred |
| CI integration               | Mandatory security gates still apply; not declared green or integration-approved                             |
| Production release           | Blocked by the five High IDs and unresolved bundled/runtime concerns; no promotion authorized                |

Evidence is retained in .security-reports/m8-g5-20261027: owner-approval.json, original target/parent preflight records, permission-results.json, complete filesystem inventories/comparison, candidate-image.json, sbom-binding.json, distroless-smoke logs/exit, verify-all logs/exit, verification-summary.json, npm-audits.json, fresh scan logs/exit and scan-comparison.json. All M8-G4/G3 and earlier records remain intact; the pre-M8-G5 report is retained verbatim. Final source/resource preservation and formatting/diff results are recorded separately alongside those files.

Final preservation evidence (final-preservation.json) checks 172 pre-existing M8G source files and finds exactly the three intended changes. All 158 original-checkout files and all 160 M8-H files match their starting hashes; heads/branch remain unchanged. Docker Desktop retains all 30 containers and 51 volume creation identities; Ubuntu retains both pre-existing containers and all 8 volume creation identities. Both old and corrected image IDs remain available. Only invocation-owned fixtures, scanner cache and builders were retired; existing PostgreSQL data volumes were not mounted or modified. Whole-repository formatting and git diff --check exit 0.

The next owner decision concerns supported native-vulnerability remediation or vendor adjudication; it is not another permission exception. Keep every High/Critical finding blocking and use the normal required CI before any integration/release acceptance. No automatic mutation retry, migration, authentication/domain/tool change, unstable library, image publication, production deployment, commit, push or merge occurs. Stop after this verification; M8-G overall remains incomplete.

## M8-G7: supported-remediation feasibility, 2026-10-28

### Scope, identity and decision

This is an assessment-only continuation on feat/m8-g-security, starting clean at bf0cc11661ae123f4672aa97608d58a779936951. AGENTS.md, docs/security.md, the complete preceding assessment, scanner controls and actual composition-root/native-runtime evidence were reviewed. Only this assessment document changes. Fresh evidence is retained under .security-reports/m8-g7-20261028; review-before-m8-g7.md preserves the verbatim preceding assessment.

**Decision: no supported remediation for these five IDs was found. Stop application-image experimentation and defer release-image promotion.** A refreshed official Trixie tag exists, but its inspected affected binaries are unchanged. Do not rebuild a complete candidate merely to replace one vulnerable digest with another. No package mixing, native-library replacement, policy exception or production approval is proposed.

The inspected experimental application is the exact M8-G5 corrected image config ID sha256:3cdae4c823875ad8609452940aac37cc4ced598c6cd78a9ecce32c8ea974c080. It is a local config identity, not a published manifest digest. The live inspection confirms Node v24.22.1, UID/GID 65532:65532, /app root:root 0755, no /app native .node add-ons, and these installed Debian binary packages:

| Binary packages                              | Installed version           | Source package                |
| -------------------------------------------- | --------------------------- | ----------------------------- |
| gcc-14-base, libgcc-s1, libgomp1, libstdc++6 | 14.2.0-19                   | gcc-14                        |
| libc6                                        | 2.41-12+deb13u4             | glibc                         |
| zlib1g                                       | 1:1.3.dfsg+really1.3.1-1+b1 | zlib 1:1.3.dfsg+really1.3.1-1 |

The Node binary SHA256 is e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb. Fresh runtime hashing binds the retained ELF files to these actual bytes before new disassembly. M8-G4's signed official Node archive/base provenance and M8-G5's complete SBOM/layer binding are reused evidence; signature verification and a new SBOM were not rerun here. The fresh probes run nonroot, offline, with read-only roots, dropped capabilities, no-new-privileges and bounded resources, without application secrets or a database connection.

### Current supported images and whether they contain a fix

Registry manifest/index and configuration bodies were fetched at 2026-10-28T12:59:01Z and their SHA256 digests checked. These are real registry identities, not invented replacement pins. Detailed manifests, configuration digests and retrieval times are retained in supported-images.json and its raw companion files.

| Official image                              | Current multi-platform index digest                                     | Linux amd64 manifest digest                                             | Finding / action                                                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gcr.io/distroless/nodejs24-debian13:nonroot | sha256:cb606325b7ec4af55462cb0b424a53b452a5b4a894ffe841fcf1048d216fb9f8 | sha256:4d0e659ef1f628c75d9940766cb444fa9605cc190b13676b9e62e1fa567c5cf4 | Unchanged from the pinned, previously verified base; no updated candidate.                                                                                      |
| node:24-trixie-slim                         | sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a | sha256:c8c4a7483bb04544293c82a3eecc3081c37ff5dfedcaf819d60e6e4aaad35b12 | New index compared with pinned 43b9ba11...; pulled and inspected, but no relevant correction. Keep source pins unchanged.                                       |
| node:24-bookworm-slim                       | sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c | sha256:e1582112fb9f152ed38eefcd712efc93fee1becb519fdfa57574d5e07eaa5e7d | New index compared with pinned 55fb5f5a...; registry/configuration inspection only. No new Bookworm application candidate or claim about its package inventory. |

Both refreshed official Node image configurations still specify 24.22.1. This is also the latest Node 24 release in the freshly retrieved [official release index](https://nodejs.org/dist/index.json). The new Trixie base was actually launched in an isolated nonroot inspection: gcc-14-base/libgcc-s1/libstdc++6 remain 14.2.0-19, libc6/libc-bin remain 2.41-12+deb13u4, and zlib1g remains 1:1.3.dfsg+really1.3.1-1+b1. Its Node, libc, libresolv, libstdc++ and OS libz hashes exactly match those inspected in the current distroless image. Bundled zlib remains 1.3.2.1-motley-285e94b. A newer image creation timestamp therefore supplies no relevant fix. The new base is retained; no existing image is deleted.

No newer Node 24 release or CVE-specific Node correction/adjudication was identified in the official release/source material checked. This bounded review is not a claim about unpublished vendor work. Current v24.x writer source was also fetched and still lacks the upstream zlib reset described below. Registry metadata alone does not establish runtime compatibility or a clean scan, and no new full-image/runtime/scan result is claimed for either refreshed tag.

### Per-advisory remediation decisions

Fresh Debian tracker pages and upstream patches are saved with retrieval/hash records. All five IDs remain High in the retained complete-image scan. Debian source-package status and scanner package matches do not establish that every matched binary contains the vulnerable function. Conversely, a missing dynamic symbol or an unobserved call path is not proof that optimized or later-loaded native code is safe.

| CVE                                                                            | Affected component                                                                                      | Installed version                                                                   | Fixed version / upstream correction                                                                                                                                             | Supported Trixie fix available?                                             | Native reachability evidence                                                                                                                                                                                                                                          | Proposed remediation                                                                                                                                                                                     | Residual uncertainty                                                                                                                 | Release disposition                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [CVE-2026-102010](https://security-tracker.debian.org/tracker/CVE-2026-102010) | GCC libstdc++ PBDS binary-heap erase_if template; scanner matches all four gcc-14 binary packages above | 14.2.0-19                                                                           | Debian gcc-14 14.4.0-3 is fixed in forky/sid; upstream aaa8351f4d2e636f9680a1f0a8ebc2f0a60611e6 corrects the post-reallocation entry pointer                                    | No; tracker still marks stable 14.2.0-19 vulnerable, no-dsa/minor           | libstdc++ is loaded, but this is header-generated consumer code. No PBDS instantiation was established in the Node executable; absence from dynamic symbols is insufficient proof.                                                                                    | Seek supported stable/vendor correction and consumer-build assessment. Rebuild any affected instantiated consumers with corrected headers; changing only runtime libraries may not repair template code. | No exhaustive optimized-code/template call graph; four source-package matches are not four demonstrated vulnerable functions.        | Blocked; no reclassification or exemption.                          |
| [CVE-2026-19499](https://security-tracker.debian.org/tracker/CVE-2026-19499)   | glibc monetary-format right-justification padding                                                       | libc6 2.41-12+deb13u4                                                               | First Debian unstable fix 2.43-5; upstream b090cf226ff65b913e41536f1f573f500855615c, with inspected stable-branch backport 63b53df549451a5d69fcba6d7612ea99f517e8e3             | No; stable remains vulnerable, no-dsa/minor                                 | Loaded libc exports strfmon/strfmon_l. No direct Node import or application call was found; an attacker-influenced formatting/buffer path has not been demonstrated.                                                                                                  | Wait for a supported stable glibc backport and official image refresh; verify exact patch and repeat complete-image checks.                                                                              | Export presence proves routines exist, not an exploitable MCP route. Installed patch equivalence was not exhaustively reconstructed. | Blocked.                                                            |
| [CVE-2026-5435](https://security-tracker.debian.org/tracker/CVE-2026-5435)     | glibc deprecated DNS presentation/debugging routines                                                    | libc6 2.41-12+deb13u4; shipped libresolv.so.2                                       | First Debian unstable fix 2.43-3; upstream ca44a6609c29a683b03575fa035c6d17aa591e72, inspected backport e64ae5a591f0604b7504df4df631857bb11cc78b removes faulty record printers | No; stable remains vulnerable, no-dsa/minor                                 | libresolv exports ns_sprintrrf and __fp_nquery. It is absent from Node's DT_NEEDED/initial mapping, and no direct relevant import was found. Ordinary DNS resolution does not establish use of these printers.                                                        | Await supported stable correction and official image, or obtain vendor build-specific disposition for review; preserve the gate meanwhile.                                                               | Initial mappings do not rule out later loading; no exhaustive native call graph. No corrupting MCP path demonstrated.                | Blocked.                                                            |
| [CVE-2026-85091](https://security-tracker.debian.org/tracker/CVE-2026-85091)   | A: Debian OS libz; B: separate zlib statically bundled into Node                                        | A: zlib1g 1:1.3.dfsg+really1.3.1-1+b1. B: Node 24.22.1, zlib 1.3.2.1-motley-285e94b | Debian sid 1:1.3.dfsg+really1.3.2-4; upstream df84af25dc1942490e1d1c899a07619152a46148 resets stale writer input state. No corrected supported Node 24 release identified.      | No stable OS fix shown; replacing OS libz would not patch bundled Node code | Both copies contain gzip writer/printf routines. OS code has the older fatal-error check. Node source and actual writer disassembly retain the pre-fix stale-input return. JavaScript bindings use deflate/inflate; no MCP route to the gz-file sequence established. | Seek Debian affected-range adjudication or supported OS correction, and a supported official Node 24 runtime carrying the bundled correction. Verify both independently.                                 | OS affected-range disagreement remains; no exploit or complete Node/native reachability proof. Detailed two-copy assessment follows. | Blocked; one advisory ID, two separate component concerns.          |
| [CVE-2026-95619](https://security-tracker.debian.org/tracker/CVE-2026-95619)   | libstdc++ aligned allocation integer-overflow branches; scanner matches the four gcc-14 binaries        | 14.2.0-19                                                                           | Debian gcc-14 14.4.0-3 in forky/sid; inspected GCC-14 correction 200183d4ab5d57575f3dfebc6af3baf649910b9e adds size-rounding checks to susceptible branches                     | No; stable remains vulnerable, no-dsa/minor                                 | Node imports aligned array new. Actual libstdc++ array new jumps to scalar aligned new, which calls posix_memalign. Upstream identifies that POSIX branch as not doing the susceptible size rounding.                                                                 | Request vendor/build-specific assessment or supported stable update. Preserve exact binary evidence; do not replace libc/libstdc++ with unstable builds.                                                 | Strong applicability disagreement for this overload/build, not proof about all overloads, architectures or four matched packages.    | Blocked pending supported remediation/review; no scanner exception. |

Vendor labels no-dsa/minor and scanner labels wont-fix/not-fixed do not approve release. No installed package or function was removed, hidden or excluded from scanning. No owner disposition has been inferred from the native evidence.

### Upstream and binary evidence behind the decisions

The [GCC PBDS correction](https://github.com/gcc-mirror/gcc/commit/aaa8351f4d2e636f9680a1f0a8ebc2f0a60611e6) changes the binary-heap erase implementation in a template header. A libstdc++ dependency alone cannot prove that Node instantiated that operation. This is why the action includes consumer-build review instead of claiming that a runtime shared-library version replacement alone repairs it.

The [aligned-allocation correction on GCC-14](https://github.com/gcc-mirror/gcc/commit/200183d4ab5d57575f3dfebc6af3baf649910b9e) distinguishes POSIX allocation from branches that round the requested size. Fresh disassembly of the exact installed libstdc++ shows aligned array new at 0xb3cc0 jumping to scalar aligned new, and the scalar implementation calling posix_memalign at 0xb3c81. Node imports that array overload. This supports a specific applicability dispute; it does not authorize dismissing the advisory or the other source-package matches.

The [glibc monetary advisory](https://sourceware.org/git/?p=glibc.git;a=blob_plain;f=advisories/GLIBC-SA-2026-0017;hb=HEAD) and [actual correction](https://gitlab.com/gnutools/glibc/-/commit/63b53df549451a5d69fcba6d7612ea99f517e8e3) concern movement length after padding updates buffer pointers. The [upstream resolver announcement](https://sourceware.org/pipermail/libc-announce/2026/000057.html) and [correction](https://gitlab.com/gnutools/glibc/-/commit/e64ae5a591f0604b7504df4df631857bb11cc78b) concern deprecated record-formatting routines, including unchecked TSIG output, rather than the ordinary DNS resolver path. These trigger distinctions guide review without establishing blanket non-exploitability. Fresh installed exports and package data support routine presence; neither glibc vulnerability was dynamically triggered in this task.

#### CVE-2026-85091 A: OS zlib

OS libz.so.1.3.1 SHA256 is 85590dd58edf5445e18bc7193e5ebc01ac5841f1ae187e97705a662e90c6421e. It contains gzip file writer and formatted-output functions, but is not in the inspected Node process's initial shared-object mapping. The [upstream nonblocking-support change](https://github.com/madler/zlib/commit/81cc0bebedd935daeb81b0b6e475d8786b51af3d) introduced the relevant newer flow in v1.3.1.2. Fresh disassembly of this OS copy's gzvprintf shows a fatal-error check before the internal move, consistent with the older flow.

That is evidence of a code-path difference, not proof that Debian's installed package is unaffected. Debian still marks the older stable package vulnerable while describing a newer affected range; its tracker explicitly points to an [unresolved range discussion](https://github.com/madler/zlib/issues/1310#issuecomment-5979623265). The Debian maintainer's question is not an upstream adjudication. Third-party comments are not treated as vendor decisions. Keep the OS finding blocking until supported correction or adequately reviewed vendor clarification; do not derive an exemption from version comparison or this one branch alone.

#### CVE-2026-85091 B: Node bundled zlib

The live executable reports zlib 1.3.2.1-motley-285e94b. Node v24.22.1 resolves to source commit ce7aaf1cee78b8cf0ce17364260535c418d3ed26. The freshly fetched [bundled writer source](https://github.com/nodejs/node/blob/ce7aaf1cee78b8cf0ce17364260535c418d3ed26/deps/zlib/gzwrite.c) has SHA256 2ce783294c688330c716bfe106f43167d3dae5be84994176bc304d205d4f5b04, as does the checked v24.x branch copy. Both lack the [upstream correction](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148) that clears avail_in and restores next_in to internal storage on the direct-write failure path.

This source finding is corroborated in the actual Node binary, not inferred solely from its version. gz_write at 0x1a27790 calls gz_comp at 0x1a278dd; the -1 return branch at 0x1a278f5 through 0x1a2790c returns without resetting input pointer/count state. The binary also contains gzwrite, gzprintf and gzvprintf, including the inlined vacate/movement flow. No equivalent reset is present in that inspected error branch. An OS libz package update cannot alter this statically bundled code.

The vulnerable sequence requires a nonblocking gzip-file write stalled with external input followed by formatted gzip output. Fresh review of [Node's JavaScript zlib binding](https://github.com/nodejs/node/blob/ce7aaf1cee78b8cf0ce17364260535c418d3ed26/src/node_zlib.cc) finds stream deflate/inflate handling, not gz-file writer/printf calls. The actual MCP composition root exposes no arbitrary FFI/native-execution tool or general gzip-file handle; no .node add-ons were found in /app. No tool-driven corrupting sequence has been demonstrated. Static symbol inspection, initial mappings and source search do not constitute a complete optimized native call graph or prove non-exploitability.

No Node-specific fix or affectedness decision was found in the official Node 24 release/source material checked; the release's generic security designation is insufficient. The safe remediation is an official supported Node 24 release containing this correction, with exact-source/binary verification and all packaged tests/scans repeated. A private patched runtime would require separate provenance, ABI, reproducibility and security review; none is built or approved here. The bundled concern remains open independently of the single OS-package match in the scanner. It does not create a sixth unique reported CVE.

### What was executed, and what evidence was reused

New M8-G7 execution:

- Read-only repository/status/code review; fresh registry index, manifest and configuration digest checks; official Node release index/source and five Debian tracker/upstream reviews.
- Exact existing distroless application-image inspection, package metadata and binary SHA256 checks; fresh ELF symbol/disassembly probes bound to those live hashes. All nine native inspection commands exit 0. Symbol absence is not used as a safety proof.
- Pull of the refreshed official Trixie base exits 0; nonroot read-only offline inspection confirms unchanged affected versions and binary hashes. This is a base inspection, not a newly built application candidate.
- Document formatting/checks and git diff --check are recorded alongside the final source/resource preservation comparison. No database is connected, no migration generator is run, and no data volume is mounted in this assessment.

Reused evidence, explicitly not newly executed M8-G7 application tests or scans:

| Evidence                                                                     | Retained result                                                                                                                                                                                                               | Limits                                                                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| M8-G6 format / verify / verify:all / db:check / db:generate / test:container | All final exits 0; 544 non-integration passed, 1 skipped; 441 PostgreSQL passed, 3 skipped; no generated migration drift                                                                                                      | See .security-reports/m8-g6-20261028/completion.json. Earlier concurrent-run failures remain preserved. No claim of a new suite run here. |
| M8-G6 Linux scanner regression / security:verify                             | 52 focused tests passed; wrapper proof exits 0 with vulnerable fixture rejected, clean fixture accepted and execution failures blocking                                                                                       | Native Linux permissions verified in M8-G6, not re-proved by a Windows-only chmod probe here.                                             |
| M8-G5 exact distroless runtime, reproducibility and permissions              | Packaged helper exits 0; all eight tools, protocol-only stdout, TLS/readiness/limits, note/audit idempotency, EOF/signals, original migration assets, four UID/root-mode permission cases and cold same-config rebuild passed | Specific corrected image 3cdae4c8...; retained functional evidence is not new security acceptance.                                        |
| M8-G5 saved npm-audits.json and supplied Linux CI dependency-audit baseline  | Production dependency wrapper and full npm audit recorded exit 0, zero findings; supplied CI dependency audit passed                                                                                                          | Does not clear OS or bundled-runtime CVEs; not a fresh npm audit or independent CI check in this task.                                    |

The user requires full application verification for material implementation changes and new full-image SBOM/scanning for changed application images. Neither occurs: only this document changes, all application/base pins remain unchanged, and no new application image is built. Accordingly the full suite, migration generation, SBOM and Grype are not rerun merely to relabel old results. Migration SQL and metadata are compared byte-for-byte with the starting source snapshot. A future supported-fix implementation must execute every required command, create a fresh complete-image SBOM, verify its exact image identity, and scan using a current verified database before acceptance.

### Retained scan counts and release gate

These are the last actual complete-image results, not fresh scans of the refreshed tags. New vendor evidence does not retroactively change them:

| Complete application image                         | Packages / all matches | High / Critical matches | Unique blocking IDs | Grype / wrapper exit | Policy result        |
| -------------------------------------------------- | ---------------------- | ----------------------- | ------------------- | -------------------- | -------------------- |
| Bookworm config 3fe50c4f... (M8-G6)                | 131 / 222              | 70 / 2                  | 20                  | 2 / 1                | vulnerability_policy |
| Experimental distroless config 3cdae4c8... (M8-G5) | 56 / 31                | 11 / 0                  | 5                   | 2 / 1                | vulnerability_policy |

Bookworm evidence: .security-reports/m8-g6-20261028/image-linux-reports/run-ae95d1fe-de65-4d9f-bcd7-657701315fd8, Grype database v6.1.10 built 2026-10-28T06:23:30Z. Distroless evidence: .security-reports/run-1589230c-c7ac-49e4-b6a4-40d98c7b194d, database v6.1.10 built 2026-10-27T06:30:41Z. Their freshness was enforced when those scans ran; historical timestamps are not permission to reuse a stale database in a future scan.

Distroless matches remain: four each for CVE-2026-102010 and CVE-2026-95619; one each for CVE-2026-19499, CVE-2026-5435 and CVE-2026-85091. The first four IDs' retained scanner state is wont-fix; OS zlib is not-fixed. Neither state changes the High threshold. Bundled Node zlib remains an additional component-level concern under CVE-2026-85091 even though the retained OS-oriented match is only one entry.

Scanner operation and vulnerability-policy outcomes remain distinct. High/Critical failure, unfixed reporting, empty exclusions/ignore/VEX, required updates, hash verification, <=120-hour database freshness, pinned Syft/Grype, fail-closed handling, private reports and per-file read-only nonroot scanner staging are unchanged. No scanner failure is relabeled as a successful security check.

### PR #2 recommendation, owner decisions and preservation

Keep PR #2 draft and keep every required gate enabled. Scanner-enforcement proof success demonstrates the gate functions; it does not make the release-image policy pass. Review the existing hardening changes and this evidence, but do not promote either current release candidate or mark M8-G complete. No remote CI rerun or PR state change is performed in this task; the supplied Linux CI baseline and retained local records are distinguished from new execution above.

Recommended owner actions:

1. Defer release-image promotion until a supported fix and unchanged-policy complete-image scan permit it. Continue monitoring supported Debian 13, official distroless and Node 24 updates; refresh only when relevant corrected code is available.
2. Authorize vendor/upstream escalation if desired: OS zlib affected-range disagreement, GCC aligned-allocation build-specific evidence, PBDS consumer instantiation, and the separate Node bundled-writer correction/affectedness decision. No vendor messages are sent here and no exception is pre-approved.
3. If waiting is unacceptable, commission a separate runtime/platform remediation review. Any custom Node build, native-library replacement or distribution migration needs explicit scope, ABI/provenance/support/reproducibility evidence and full runtime/security verification. This assessment neither implements nor recommends unstable/stable package mixing or a gate bypass.

Application/domain logic, all eight tool contracts, trusted local identity and production-auth restrictions, tenant predicates, verified PostgreSQL TLS, lifecycle/limits, transactional auditing/idempotency, H1 migration serialization, H2 recovery, all original migration bytes and scanner policy remain unchanged. Root-owned application artifacts and the original nonroot runtime are preserved. Local stdio still trusts the OS account and launcher; native applicability uncertainty is not independent authentication or production approval.

The final source/resource comparison is retained in .security-reports/m8-g7-20261028/final-preservation.json. Only docs/m8-g-security-review.md is an intended tracked change. Original and M8-H source hashes/heads, existing image IDs, containers and volume creation identities are checked against the initial snapshot. No database/volume/image is deleted, and existing data volumes are not used. No commit, push, merge, deploy or publication occurs. Stop after this assessment; release eligibility remains **no**.

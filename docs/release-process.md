# Release Process

How skfiy-next releases are built, provenanced, signed, notarized, and
published. The pipeline is `.github/workflows/release.yml`; this document
explains how it works, the one-time Apple setup it consumes, and the
invariants upgrades rely on.

## Pipeline overview

```
push tag v*  ──► build ──► smoke ──► sign-notarize-release ──► GitHub Release
                 │           │            │
                 │           │            ├─ import Developer ID identity
                 │           │            ├─ codesign --deep + hardened runtime
                 │           │            ├─ notarytool submit --wait + staple
                 │           │            ├─ ditto zip (post-staple) + SHA256SUMS
                 │           │            ├─ generate-release-notes
                 │           │            └─ gh release create (--prerelease for v0.* / hyphen)
                 │           │
                 │           └─ smoke:cli / smoke:chrome / smoke:ui against the
                 │              not-yet-signed build (pre-signing regression window)
                 │
                 ├─ typecheck + vitest re-run on the tag itself
                 ├─ clean-tree guard
                 ├─ npm run build (package-macos-app embeds build-info.json)
                 └─ verify-build-provenance gate (embedded commit === GITHUB_SHA)
```

Re-runs: `workflow_dispatch` with a `tag` input rebuilds an existing tag.

## Build provenance (closes known-gap #4)

The old flow wrote an external manifest after the fact and only checked it
against local HEAD — nothing bound the manifest to the actual artifacts. The
new flow captures identity at build time, inside the packaging step:

1. `scripts/generate-build-info.mjs` (`createBuildInfo`) reads the live
   checkout:
   - `version` — root `package.json` (same source as bundled
     `Resources/app/package.json` and `app.getVersion()`; no new version
     source of truth)
   - `commitSha` — full 40-char `git rev-parse HEAD`
   - `treeStatus` — `clean` / `dirty` from `git status --porcelain`
   - `buildTimeIso`, `nodeVersion`, `electronVersion`, `builder`
     (`github-actions` when `GITHUB_ACTIONS=true`, else `local`), `runner`
   - Without git (source tarball) it degrades to `commitSha: "unknown"`,
     `treeStatus: "unknown"` — packaging still succeeds, but the release
     gate's `--require-clean` rejects such a build.
2. `scripts/package-macos-app.mjs` writes the result to
   `Contents/Resources/build-info.json` **after** copying `dist/main`,
   `dist/renderer`, `dist/shared`, and the helper, and **before** adhoc
   signing, so the signature covers it. `Resources/` survives notarization
   and is readable at runtime via `process.resourcesPath`.
3. The release workflow runs
   `scripts/verify-build-provenance.mjs --commit "$GITHUB_SHA" --version
   "${TAG#v}" --require-clean`, which fails unless:
   - `build-info.json` exists, parses, and has `schemaVersion: 1`
   - embedded `commitSha` === `GITHUB_SHA` (the anti-relabeling check)
   - embedded `version` === tag version === bundled
     `Resources/app/package.json` version === root `package.json` version
   - `treeStatus` is `clean`
   - `appName` is `skfiy`

A pre-existing app built from another commit carries its own embedded
commit and cannot pass the gate without rebuilding — which is exactly the
property provenance needs.

### App-side surfacing

- `skfiy diagnostic` (`readComponentVersions`) reports the app component
  version with `commit` (short SHA) and `buildTime` when
  `Contents/Resources/build-info.json` is present; state degrades to
  `unknown` when it is absent (dev builds).
- `skfiy provenance` prints the embedded build-info plus the `codesign -dv`
  signing identity, so users can see who built and signed the app.

### Optional hardening (future)

- `actions/attest-build-provenance@v2` already runs on the release zip
  (guarded to tag pushes, `id-token: write` on the sign job) for
  SLSA-verifiable attestation alongside the embedded build-info.
- A sha256 of the `dist/` payload could be computed before writing
  build-info and recorded inside it, binding the compiled sources to the
  commit. Not required to close gap #4.

## One-time Apple setup

The workflow only consumes secrets; the Apple-side material is created
manually once.

1. Apple Developer Program membership. Create a **Developer ID Application**
   certificate in the developer portal (or via Xcode), export it with its
   private key as a `.p12` with a strong password.
2. Base64 the p12 and add GitHub secrets
   (Settings → Secrets and variables → Actions):
   - `APPLE_CERTIFICATE_P12` — `base64 -i cert.p12 | pbcopy`
   - `APPLE_CERTIFICATE_PASSWORD` — the p12 password
   - `SKFIY_DEVELOPER_ID_APPLICATION` — exact identity name from
     `security find-identity -v -p codesigning`
     (e.g. `Developer ID Application: ... (TEAMID)`)
3. Create an App Store Connect app-specific password at appleid.apple.com
   and add:
   - `APPLE_ID` — Apple ID email
   - `APPLE_TEAM_ID` — 10-char team id
   - `APPLE_APP_SPECIFIC_PASSWORD` — the app-specific password

### Keychain-profile alternative (local releases)

Instead of the Apple ID / team id / password trio, store notarytool
credentials once in the login keychain:

```
xcrun notarytool store-credentials "skfiy-notary" \
  --apple-id "you@example.com" --team-id "TEAMID" --password "xxxx-xxxx-xxxx-xxxx"
```

then set `APPLE_KEYCHAIN_PROFILE=skfiy-notary` (or pass
`--keychain-profile`). A keychain profile satisfies notarization readiness
on its own.

## Cutting a release

```
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds, gates, smokes, signs, notarizes, and publishes. Tags
matching `v0.*` or containing a hyphen (`v0.1.0-alpha.1`) publish as GitHub
pre-releases without a manual flag; `v1.0.0` onward publish as full
releases.

Release notes are generated by `scripts/generate-release-notes.mjs` from
conventional-commit history between the previous tag
(`git describe --tags --abbrev=0 <to>^`) and the release tag, with the
provenance footer taken from the verified embedded build-info and the
just-computed `SHA256SUMS`. The first release falls back to the full commit
list.

## Local validation

```
npm run release:mac:check          # dry-run: readiness + planned commands, secrets redacted
npm run release:mac -- --sign --notarize --execute   # real signed local release
npm run build:info                 # write build-info for inspection
npm run verify:provenance -- --app dist/skfiy.app --commit "$(git rev-parse HEAD)" --version "$(node -p "require('./package.json').version")" --require-clean
npm run release:notes -- --to v0.1.0   # dry-run notes to stdout
```

Every release script is read-only by default and only mutates with an
explicit `--execute` flag. The `--password` value is always masked as
`<redacted>` in printed/planned commands.

## First-launch / permission identity

Notarized releases open with a normal double-click; Gatekeeper shows the
Developer ID identity, verifiable with:

```
codesign -dv --verbose=4 /Applications/skfiy.app
spctl --assess --type execute --verbose /Applications/skfiy.app
xcrun stapler validate /Applications/skfiy.app
```

Unsigned dev builds (`npm run build`) still require right-click > Open once.
The app's first-run readiness surfaces TCC/permission state inside the UI.

## Upgrade invariants

Upgrades replace `/Applications/skfiy.app`; the following paths and
identifiers are stable and must never change:

- **Bundle identifier `com.sskift.skfiy`** — `userData`
  (`~/Library/Application Support/skfiy`) is keyed by it, so sessions,
  memory, profiles, and automation definitions survive upgrades.
- **Native-host manifest path** —
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sskift.skfiy.json`
  is outside the bundle and stable; the app regenerates the manifest if
  extension IDs change. The existing `manifestMatches` status check
  (`chrome-native-host.ts`) is the runtime drift detector, and the release
  `smoke:chrome` lane exercises native-host install/status plus the browser
  adapter on every release.
- **CLI shim path inside the bundle** — stable across upgrades, so the
  installed `skfiy` CLI keeps resolving.

## codesign --deep caveat

`codesign --deep` is deprecated by Apple but still functional and matches
the old-repo prior art: it re-signs the nested Electron Framework,
helpers, and `skfiy-helper` (replacing the adhoc signatures packaging
applies) in one pass. The explicit alternative is to sign each nested code
path individually (the list in `createNestedCodePaths`) before signing the
outer bundle. Either is acceptable for v1; if Apple removes `--deep`,
switch to the explicit nested-sign sequence.

## Workflow-level verification (manual)

1. Push a `v0.0.1-alpha` tag to a throwaway branch/fork with dummy secrets
   to exercise the YAML.
2. Negative test: tamper with `dist/skfiy.app/Contents/Resources/build-info.json`
   after build and confirm the provenance gate **fails**.
3. Confirm `gh release view` shows the prerelease flag, zip,
   `build-info.json`, and `SHA256SUMS`.
4. On a clean Mac: download the zip, unzip, `spctl --assess -vv` passes,
   `xcrun stapler validate` passes, the app launches with a double-click
   (no right-click), and `skfiy provenance` shows the embedded commit.

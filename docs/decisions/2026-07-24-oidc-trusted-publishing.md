# ADR: OIDC Trusted Publishing for npm

**Date**: 2026-07-24
**Status**: PROPOSED — not yet active (requires npm-side configuration)
**Distilled from**: oh-my-pi@c84e9c020 `CONTRIBUTING.md:313-317` + `.github/workflows/release.yml` (GPL-3.0 — pattern only, not code)

## Context

pi-crew currently publishes to npm manually via `npm publish` using a long-lived `NPM_TOKEN` (npm user `bom0792`). This has two supply-chain weaknesses:

1. **Token theft surface**: a long-lived npm token stored as a GitHub secret can be exfiltrated via a compromised dependency or workflow `pull_request_target` misuse. The token grants full publish access until manually rotated.
2. **No build attestation**: published packages carry no cryptographic proof of *what CI built and published them*. Consumers cannot verify a `pi-crew@x.y.z` tarball came from this repo's CI.

The v0.9.3 mid-CI-publish incident class (publishing mid-run rather than from a dedicated gated workflow) is a third motivator: a dedicated release workflow moves publishing out of the general CI run and into a controlled, test-gated path.

## Decision

Adopt **npm Trusted Publishing (OIDC)** + **provenance attestation**, following the pattern oh-my-pi@c84e9c020 uses (`id-token: write`, no `NPM_TOKEN`, `--provenance`):

1. Eliminate the long-lived `NPM_TOKEN`. Instead, GitHub Actions exchanges an OIDC token for a short-lived npm publish credential at publish time. No token to steal.
2. Attach **provenance** (Sigstore-signed build attestation) to every published tarball. Consumers can verify origin with `npm audit signatures`.

## Implementation steps (external + code)

### A. npm-side (manual, one-time — cannot be done from code)

1. Go to `https://www.npmjs.com/package/pi-crew/access`
2. Under **Publishing access**, switch to **Require two-factor authentication and disallow tokens** (or set up Trusted Publishing if available for the account).
3. Alternatively, use `npm token create --cidr` to scope a publish-only token to GitHub Actions IPs (weaker than OIDC but simpler).
4. For full OIDC: configure the npm-side Trusted Publishing link to `baphuongna/pi-crew` + the `release.yml` workflow.

### B. Code-side (when OIDC is configured)

1. Add `.github/workflows/release.yml` (sample below) — **manual trigger only** (`workflow_dispatch`) until proven stable.
2. Do **NOT** add `provenance=true` to a global `.npmrc` — that breaks local `npm publish` with "requires CI environment". Provenance must be a `--provenance` flag inside the CI workflow only.

### Sample `release.yml` (MIT-licensed, pi-crew style — not copied from oh-my-pi)

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      version:
        description: 'Version to publish (must match package.json)'
        required: true
        type: string

permissions:
  contents: write
  id-token: write  # OIDC for trusted publishing

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  publish:
    runs-on: ubuntu-latest
    environment: release  # requires manual approval via GitHub environment protection
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'

      - run: npm ci

      - name: Verify version matches input
        run: |
          PKG_VERSION=$(node -p "require('./package.json').version")
          if [ "$PKG_VERSION" != "${{ inputs.version }}" ]; then
            echo "Version mismatch: package.json=$PKG_VERSION input=${{ inputs.version }}"
            exit 1
          fi

      - run: npm run typecheck
      - run: npm run test:critical
      - run: npm run build:bundle

      - name: Publish with provenance
        run: npm publish --provenance --access public
        # No NPM_TOKEN env — OIDC trusted publishing exchanges the job's
        # id-token for a short-lived credential automatically.

      - name: Create GitHub release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: v${{ inputs.version }}
          generate_release_notes: true
```

## What this prevents

- **Token exfiltration**: no long-lived `NPM_TOKEN` secret to steal.
- **Unverified publishes**: every tarball carries a signed attestation linking it to this repo's CI.
- **Accidental publishes**: `workflow_dispatch` + `environment: release` (protected) requires manual approval before publish runs.

## Why not active yet

- npm-side Trusted Publishing / token-lockdown must be configured at `npmjs.com/package/pi-crew/access` first.
- The `environment: release` protection rule (required reviewers) must be configured in GitHub repo settings.
- Until both are done, keep the manual `npm publish` + GitHub release flow.

## Trade-off

OIDC trusted publishing is slightly less convenient than a long-lived token (each publish goes through a workflow dispatch + approval). The supply-chain hardening is worth it for a package with 700+ files shipping to public npm.

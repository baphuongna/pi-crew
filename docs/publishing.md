# Publishing pi-crew

This package is published as the scoped public npm package:

```text
pi-crew
```

Before publishing to npm:

1. Confirm package metadata in `package.json`:
   - `author`
   - `repository`
   - `homepage`
   - `bugs`
   - `publishConfig.access = public`
2. Confirm license and notices:
   - keep `LICENSE`
   - keep `NOTICE.md`
   - document copied/adapted MIT source if any substantial code is ported
3. Run checks:

```bash
npm run check
```

For a fast pre-publish smoke (97 broker/UI/config tests in ~20s, instead
of the full ~6,500-test `npm run check` which takes minutes):

```bash
npm run test:critical && npm run typecheck && npm run build:bundle
```

4. Verify package contents:

```bash
npm pack --dry-run
```

Confirm bundled skills ship (the `real-test-pi-crew` skill references
`scripts/pty_probe.py`):

```bash
npm pack --dry-run 2>&1 | grep -E 'skills/|pty_probe'
```

5. Verify local install in Pi:

```bash
pi install ./pi-crew
/team-doctor
/team-validate
```

6. Publish when ready:

```bash
npm publish --access public
```

Users can install the published package with:

```bash
pi install npm:pi-crew
```

### Postinstall

`npm install` / `pi install` triggers `scripts/postinstall.mjs`, which:

1. Builds the ESM bundle (`scripts/build-bundle.mjs`) — best-effort, falls
   back to strip-types loading if esbuild is missing.
2. Installs the bundled `crew-vibes.ttf` font into the user fonts directory.
3. Copies every `skills/<name>/` dir to `~/.pi/agent/skills/` so pi-crew's
   skills are available globally (not just inside the pi-crew project).

All three steps are best-effort and never fail the install.

## Config schema

The package exports:

```text
./schema.json
```

Use this for editor validation of:

```text
~/.pi/agent/extensions/pi-crew/config.json
```

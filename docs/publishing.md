# Publishing pi-teams

This package is published as the scoped public npm package:

```text
@bom0792/pi-teams
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

4. Verify package contents:

```bash
npm pack --dry-run
```

5. Verify local install in Pi:

```bash
pi install ./pi-teams
/team-doctor
/team-validate
```

6. Publish when ready:

```bash
npm publish --access public
```

Users can install the published package with:

```bash
pi install npm:@bom0792/pi-teams
```

## Config schema

The package exports:

```text
./schema.json
```

Use this for editor validation of:

```text
~/.pi/agent/extensions/pi-teams/config.json
```

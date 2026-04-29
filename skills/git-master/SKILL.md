---
name: git-master
description: Commit and release hygiene for safe version-control work. Use when preparing commits, releases, version bumps, publishing, or validating package installation.
---

# git-master

Use this skill for commit/release hygiene.

## Commit rules

- Check `git status --short` before staging.
- Stage only files related to the current task.
- Keep commits independently revertible.
- Use concise imperative commit messages.
- Do not push or publish unless explicitly requested.
- Do not include secrets, OTPs, local temp files, or generated tarballs.

## Release rules

- Run the required verification gate before version bumps.
- Bump version only after tests pass and user confirms publish intent.
- Verify registry after publish with `npm view`.
- Install through `pi install npm:pi-crew` when validating Pi package loading.

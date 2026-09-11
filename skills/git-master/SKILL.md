---
name: git-master
description: >
  Commit and release hygiene for safe version-control work.
  When NOT to use: experimental branches (use worktree-isolation); force-push or history rewrites (use scrutinize first).

origin: pi-crew
triggers:
  - "commit this"
  - "tag release"
  - "bump version"
  - "publish package"
  - "prepare release"
---
# git-master

Use this skill for commit/release hygiene. This skill covers git workflow from local changes to published releases.

## Pre-commit Checklist

Before every commit:

1. Run `git status --short` — understand what changed
2. Stage only files related to the current task
3. Review staged diff with `git diff --staged`
4. Check for unintended changes (generated files, temp files, secrets)
5. Ensure tests pass locally before committing

## Commit Rules

- **Independent commits**: Each commit should be self-contained and revertible. Don't mix unrelated changes.
- **Concise messages**: Use imperative mood, 50 chars or less for subject. Add body for context.
- **Format**: `type(scope): subject` where type is `fix`, `feat`, `chore`, `docs`, `test`, `refactor`
- **Do not include**: secrets, OTPs, local temp files, `node_modules`, `dist/`, `*.log`, `*.tmp`
- **Do not push/publish** unless explicitly requested
- **Verify** before staging large generated files (tarballs, build outputs)

## Commit Message Format

```
type(scope): short description (50 chars max)

 Longer description if needed. Explain WHY the change was made,
 not just what changed. Reference issues/PRs if applicable.

Refs: #123
```

**Examples:**
```
fix(live-agent): prevent cross-workspace agent access
feat(widget): add snapshot cache with 500ms TTL
docs(skills): add event-log-tracing skill
chore(tests): add integration test for reconcileAllStaleRuns
```

## Branch Naming

| Pattern | Use case | Example |
|---|---|---|
| `fix/<description>` | Bug fixes | `fix/ghost-run-display` |
| `feat/<description>` | New features | `feat/skill-templates` |
| `docs/<description>` | Documentation | `docs/skills-deep-research` |
| `chore/<description>` | Tooling, CI | `chore/update-ci-node22` |
| `hotfix/<description>` | Urgent production fixes | `hotfix/secret-leak` |

## Rollback Procedures

### Revert last commit (safe, keeps history)
```bash
git revert HEAD
git push
```

### Reset to known-good state (rewrites history)
```bash
# Soft: keep changes staged
git reset --soft HEAD~1

# Mixed: keep changes unstaged
git reset HEAD~1

# Hard: discard all changes (DESTRUCTIVE)
git reset --hard <commit-hash>
```

### Checkout single file from a past commit
```bash
git checkout <commit-hash> -- path/to/file
```

### Recover from a bad reset
```bash
git reflog  # find the commit before reset
git reset --hard <reflog-entry>
```

## Regression Hunting with git bisect

When a regression is found and the culprit commit is unknown:

```bash
git bisect start
git bisect bad              # current commit is bad
git bisect good <known-good> # a commit that worked

# git checks out a middle commit
# test it: if bad, mark it; if good, mark it
# repeat until culprit found
git bisect bad   # or: git bisect good

# after bisect completes:
git bisect reset  # return to original branch

# culprit is the first bad commit in the range
```

## Amend and Force-Push

### Amend last commit (before push)
```bash
# Make additional changes
git add .
git commit --amend --no-edit  # amend without changing message
git commit --amend -m "new message"  # or with new message
```

### Force-push (DESTRUCTIVE — only when necessary)
```bash
# Only force-push to feature branches, never main/master
git push --force-with-lease origin <branch>

# --force-with-lease is safer: fails if someone else pushed
# Regular --force can overwrite others' work
```

**When safe to force-push:**
- Your feature branch that only you use
- After `git rebase` (rebase rewrites commit history)
- After amending commits not yet pushed

**When to NEVER force-push:**
- Shared branches (main, master, develop)
- Branch with active PR
- Branch others may have based work on

## Tag and Release

### Create a version tag
```bash
git tag -a v1.2.3 -m "Release 1.2.3: Add skill templates"
git push origin v1.2.3
```

### Tag after version bump
```bash
git add CHANGELOG.md package.json
git commit -m "chore: bump version to 1.2.3"
git tag -a 1.2.3 -m "Version 1.2.3"
git push && git push --tags
```

### List and verify tags
```bash
git tag -l
git show <tag-name>
```

## Version Bump Sequence

1. Verify: `npx tsc --noEmit` passes
2. Verify: `npm test` passes
3. Update `CHANGELOG.md` with changes for this version
4. Update `package.json` version field
5. Commit: `chore: bump version to X.Y.Z`
6. Tag: `git tag -a X.Y.Z -m "Release X.Y.Z"`
7. Publish: `npm publish --access public`
8. Verify: `npm view pi-crew` shows new version

## Stash Patterns

### Stash work-in-progress
```bash
git stash -u           # include untracked files
git stash push -m "WIP: feature X"  # with message
```

### Apply and manage stashes
```bash
git stash list         # show all stashes
git stash pop          # apply latest and remove
git stash apply         # apply latest, keep in stash
git stash apply stash@{2}  # apply specific stash
git stash drop          # remove latest stash
git stash clear         # remove all stashes
```

## Enforcement — Git Master Gate

**Before committing or publishing, verify:**

- [ ] `git status` reviewed — only related files staged
- [ ] `git diff --staged` reviewed — no unintended changes
- [ ] Tests pass locally (`npm test` or appropriate test command)
- [ ] No secrets in staged changes (API keys, tokens, passwords)
- [ ] Commit message follows format: `type(scope): subject` (50 chars or less)
- [ ] No generated files staged unless intentional

If ANY answer is NO → Stop. Fix issues before committing.

## Anti-patterns

- **Committing generated files**: Don't commit `dist/`, `build/`, `*.min.js` unless intentional
- **Large commits**: If >500 lines changed, consider splitting
- **Committing with unverified tests**: Run tests before commit
- **Force-pushing main/master**: Never
- **Committing secrets**: Check for `API_KEY`, `TOKEN`, `PASSWORD`, `SECRET` before staging
- **Unclear messages**: "fix stuff" is not a valid commit message

## Source patterns

- `src/state/atomic-write.ts` — atomic git-safe file writes
- `src/worktree/worktree-manager.ts` — worktree git operations
- `src/utils/conflict-detect.ts` — git conflict detection
- `package.json` — version field, publish scripts

## Verification

```bash
cd pi-crew
git status --short
git log --oneline -5
git diff --staged --stat

# TypeScript
npx tsc --noEmit

# Tests
npm test

# Package dry-run before publish
npm pack --dry-run
```
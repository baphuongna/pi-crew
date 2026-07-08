# Notices

`pi-crew` is designed as a Pi-native team orchestration extension.

## Source inspiration

- Primary design and Pi-extension implementation inspiration: `pi-subagents` by Nico Bailon, MIT license.
- Team orchestration, state, and worktree contract inspiration: `oh-my-claudecode` by Yeachan Heo, MIT license.
- Conceptual inspiration only: `oh-my-openagent` / `oh-my-opencode`, SUL-1.0. No source code from this project should be copied into `pi-crew` unless explicitly reviewed for license compatibility and documented here.
- Built-in skill topics are original pi-crew guidance informed by common agent-skill patterns in `Source/awesome-agent-skills`, `Source/oh-my-claudecode`, and related local references; no verbatim skill text was copied.

## Copied code policy

When code is copied or substantially adapted from an MIT source, add the source path and license note here.

Current scaffold status: no substantial source files have been copied verbatim; implementation is a fresh scaffold based on documented design lessons.

## crew-vibes font assets

- `assets/runner-spritesheet.png` and the 16 runner glyphs (U+E700..U+E70F) traced
  from it in `assets/crew-vibes.ttf` are adapted from the RunCat sprite art of
  `pi-speeed` by somus (MIT license, https://github.com/somus/pi-speeed), which
  itself traces inspiration to `pi-runcat` by FredySandoval. The silhouettes are
  re-traced (bitmap -> contour) into a new Private-Use-Area font; no font binary
  was copied verbatim.
- The token-speed engine in `src/extension/crew-vibes/speed.ts` is adapted from
  `pi-speeed` (MIT license, https://github.com/somus/pi-speeed).
- The capacity meter concept is adapted from `pi-chonk` by somus (MIT license,
  https://github.com/somus/pi-chonk); the boat+crew figures (U+E710..U+E715) are
  original vector drawings.

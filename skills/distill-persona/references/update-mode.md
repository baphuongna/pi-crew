## Update mode
"update <person>'s skill": read existing, find `distilled:` date; run only streams 2 + 5 + 6 (recent); merge (strengthen / flag contradiction / add new model); update date + latest-dynamics. Never rewrite wholesale.

**No-op detection**: after merge, if no model was added/strengthened/contradicted → report "no new contribution since last distillation; existing skill is current." Do NOT re-ship an unchanged skill — it wastes cost and pollutes the registry with false "updated" timestamps. Also check for a pre-existing update in progress before starting (idempotency).

**Deletion tracking (#12)**: updates must also log what was *removed* (`### Removed` section in the skill's changelog/BUILD-NOTES), not just added. A skill that only ever grows drifts — stale heuristics never get pruned. Enumerate each retired model/heuristic/source with a 1-line reason; if nothing was removed, state "no removals" explicitly (auditable).


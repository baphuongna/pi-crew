---
name: pipeline
description: Multi-stage pipeline (research → analyze → synthesize → document) producing pipeline-summary.md
topology: sequential
---

## research
role: explorer

Gather relevant facts for: {goal}. Identify key concepts and provide a structured summary.

## analyze
role: analyst
dependsOn: research

Analyze and organize the research findings. Identify patterns, relationships, and insights with supporting evidence.

## synthesize
role: analyst
dependsOn: analyze

Synthesize the analysis into prioritized, actionable recommendations with clear next steps.

## document
role: writer
dependsOn: synthesize
output: pipeline-summary.md

Write the final pipeline summary combining research, analysis, and synthesis. Include executive summary, detailed findings, and recommendations. End the output with a final line that reads exactly: PIPELINE_WORKFLOW_OK

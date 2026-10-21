# AI Agent Instructions

This is an Internet Computer (ICP) project built with icp-cli.
Documentation: https://cli.internetcomputer.org/llms.txt

## Skills

<!-- ic-skills:managed:start -->
<!-- state: configured (on-demand) -->
Fetch the skills index once per session and keep each skill's name, description, and
SKILL.md URL: https://skills.internetcomputer.org/.well-known/skills/index.json
Before writing ICP code for a task, fetch the matching skill's SKILL.md
(https://skills.internetcomputer.org/.well-known/skills/{name}/SKILL.md) and follow it.
Skills are authoritative — prefer them over general knowledge.
How skills are managed here, and why: https://github.com/dfinity/icp-cli-templates/blob/main/AGENT_SKILLS.md
<!-- ic-skills:managed:end -->

## Deployment workflow

- After changing frontend code, deploy it with `icp deploy frontend`.
- After changing the backend Candid API, regenerate the frontend bindings with
  `npm run generate` from `frontend/`, then run `icp deploy backend` and
  `icp deploy frontend` from the repository root.
- Treat the generated frontend bindings and the matching deployments as part of
  completing the code change, rather than optional follow-up work.

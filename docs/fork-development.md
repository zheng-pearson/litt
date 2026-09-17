# Litt fork development

Litt is developed in [zheng-pearson/litt](https://github.com/zheng-pearson/litt),
a GitHub fork of [vellum-ai/vellum-assistant](https://github.com/vellum-ai/vellum-assistant).

## Branches and remotes

The default development branch is `feat/multi-tenant-telegram-router`. It
contains the Litt changes on top of the original Vellum history. The fork's
`main` branch retains the upstream snapshot from fork creation; it does not
contain the Litt implementation.

For the existing shared checkout:

- `origin` points to `zheng-pearson/litt` and is the default push remote.
- `upstream` points to `vellum-ai/vellum-assistant`.
- `legacy-origin` preserves the earlier standalone `kzfsg/vellum-assistant` copy.

Keep feature work on its own branch. Merge upstream updates deliberately after
reviewing and testing them; do not replace the Litt branch with upstream `main`.
Git pushes do not replace the explicit Vercel and Daytona deployment procedures
in [the hosted service documentation](../examples/vercel-daytona/README.md).

## Concurrent worktrees

Worktrees share Git remotes and branch references but have separate working
files and indexes. Coordinate remote changes across active tasks. Do not reset,
rebase, switch, or clean another task's checkout while it is editing files.

Finish and commit a feature in its own worktree before integrating it. Bring
shared hosted-service changes into that branch carefully: replacing an entire
untracked directory from an older worktree can discard newer connector,
notification, or deployment work. Compare changes against each task's starting
snapshot and preserve independent edits.

Keep local credentials, `.vercel` project metadata, environment files, generated
snapshot archives, and worktree directories out of commits. The shared checkout
uses SSH for the fork remote, authenticated as the fork owner. Other projects
can keep their existing GitHub CLI account selection.

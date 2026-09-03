# busfactor (published as `truckguard`)

Ranks your direct npm dependencies by how badly you'd be stuck if the maintainers vanished. The
repository, GitHub issue tracker, and internal domain terms remain `busfactor`; the public npm
package and CLI command are published as `truckguard` (see [ADR-0002](docs/adr/0002-rename-npm-package-to-truckguard.md)).

## Agent skills

### Issue tracker

Issues live as GitHub issues in `fredykohv/busfactor`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The default canonical vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

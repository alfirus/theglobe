# Contributing

This repository follows the org Architecture Decision Record (ADR) standard. The rule below is a merge gate: an architecturally significant PR is blocked until its ADR has been merged.

## Architecture Decision Records — Engineering Repo Contributing Rule

### ADR Requirement

Any architecturally significant decision must be recorded as an ADR in `docs/adr/` **before** implementation begins. This is a gate, not optional.

#### What triggers an ADR

Decisions involving any of the following require an ADR:
- Technology stack choice (language, framework, database)
- Schema or data model change
- Authentication / authorization model
- Third-party service integration
- Cross-service contract or API design
- Infrastructure deployment pattern
- Security architecture change

### Workflow

1. Draft the ADR in `docs/adr/NNNN-title.md` with Status = **Proposed**.
2. Share it with the squad for review (Lisa, Elizabeth, Alya, Kira, Balqis).
3. Mirza or Maisarah reviews and changes status to **Accepted**.
4. The ADR PR is merged before any implementation work starts.

### Implementation linkage

The implementing kanban card body and the implementation PR must reference the accepted ADR ID (e.g., `ADR 0002`). This creates a traceable link from decision to code.

### Referencing

See `docs/adr/README.md` for full conventions: numbering, naming, superseding rules, and who may accept decisions.

## Guard: never commit `objects/` or `.git` entries (PR #11)

A git object store must never be committed to the tree. CI enforces this on
every push and PR via the `guard · no objects/ or .git in tree` job, which
runs `scripts/guard-no-git-objects.sh` against the pushed tree. Check locally
before pushing:

```sh
npm run guard --prefix frontend
```

Optional local pre-commit hook (same check on staged paths):

```sh
printf '#!/bin/sh\nbash scripts/guard-no-git-objects.sh --staged\n' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

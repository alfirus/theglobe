# Glob Interface — Agent Workflow

## The Team

| Agent | Role | What They Do |
|-------|------|-------------|
| **Sofia** | Planner & Orchestrator | Designs architecture, evaluates reviews, delegates to Shiela |
| **Shiela** | Builder | Implements code based on Sofia's plans |
| **Maisarah** | QA Reviewer | Reviews code, finds bugs/gaps, reports to Sofia |

## The Workflow

```
┌─────────────────────────────────────────────────┐
│                                                  │
│   1. SOFIA plans                                 │
│      └── Writes detailed implementation plan     │
│      └── Updates BLUEPRINT.md if needed          │
│                                                  │
│   2. SHIELA builds                               │
│      └── Implements the plan                     │
│      └── Commits to the theglobe repo            │
│                                                  │
│   3. MAISARAH reviews                            │
│      └── Reads BLUEPRINT.md (the spec)           │
│      └── Reads all source files                  │
│      └── Checks against QA checklist             │
│      └── Writes REVIEW.md in repo                │
│      └── Reports summary to Sofia via chat       │
│                                                  │
│   4. SOFIA evaluates                             │
│      └── Reads REVIEW.md                         │
│      └── Decides which issues are valid          │
│      └── Filters false positives                 │
│      └── Prioritizes fixes                       │
│                                                  │
│   5. SHIELA fixes                                │
│      └── Sofia sends filtered review to Shiela   │
│      └── Shiela fixes the issues                 │
│      └── Commits fixes                           │
│                                                  │
│   6. Repeat from step 3 until PASS               │
│                                                  │
└─────────────────────────────────────────────────┘
```

## How to Invoke Each Agent

Paths below use `<repo>` for your local clone of `github.com/alfirus/theglobe`
(e.g. `C:\Users\<you>\theglobe`) — substitute your own path; never commit
machine-specific paths to this file.

### Sofia → Shiela (build/fix)
```bash
hermes chat -p shiela -q "Implement the following task in <repo>:

[Detailed plan]

After implementation, verify with: [verification command]"
```

### Sofia → Maisarah (review)
```bash
hermes chat -p maisarah -q "Review the theglobe project at <repo>.

Then follow the review process:
1. Read BLUEPRINT.md (the spec)
2. Read all source files in frontend/src/ (server routes live in
   frontend/src/routes/api/ — there is no bridge/ directory)
3. Check against the QA checklist
4. Append the findings to <repo>/REVIEW.md
5. Report summary to Sofia via chat"
```

### Sofia evaluates review
- Read the REVIEW.md Maisarah produced
- Decide: which issues are valid? Which are false positives?
- Prioritize: critical bugs first, then warnings, then info

### Sofia → Shiela (fix)
```bash
hermes chat -p shiela -q "Fix the following issues found in review at <repo>:

[Filtered list of issues from REVIEW.md]

For each fix:
1. Read the affected file
2. Apply the fix
3. Verify the fix works
4. Commit with descriptive message"
```

## Review Cadence

- **After each phase completion** → full review
- **After major feature adds** → targeted review
- **Before merging to main** → mandatory review
- **Sofia can request ad-hoc reviews** anytime

## Communication Protocol

- **Maisarah → Sofia**: Chat summary + REVIEW.md file
- **Sofia → Shiela**: Filtered review + specific fix instructions
- **All agents**: Use the theglobe repo for code, REVIEW.md for tracking

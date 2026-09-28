## What does this PR do?

<!-- Brief description of changes -->

## Type of Change

- [ ] 🐛 Bug fix (non-breaking change that fixes an issue)
- [ ] ✨ New feature (non-breaking change that adds functionality)
- [ ] 💥 Breaking change (fix or feature that would cause existing functionality to change)
- [ ] 📝 Documentation update
- [ ] ♻️ Refactoring (no functional changes)
- [ ] 🧪 Test update
- [ ] 🔧 Chore (dependencies, CI, tooling)

## Related Issues

Closes #

## Kanban

Card: `t_644b7899` — P1-5 test + CI baseline (Vitest API/db tests, Playwright `@smoke`, GitHub Actions gate)

<!--
Name the kanban card this PR delivers, e.g. `t_644b7899`.
QA sign-off (Balqis) is required before merge; the required status check is
`check · unit · smoke · build` (see .github/workflows/ci.yml).
-->

## ADR

ADR: `<link to docs/adr/NNNN or 'n/a — not architecturally significant'>`

<!--
Replace the placeholder with the ADR this PR implements, e.g.:
  ADR: docs/adr/0001-use-postgres-for-orders
  ADR: n/a — not architecturally significant
An architecturally significant change (technology stack, schema or data
model, auth, third-party service, cross-service contract) needs its ADR
merged before this PR — CONTRIBUTING rule (docs/adr/README.md).
-->

## Checklist

- [ ] Architecturally significant change? → ADR merged first (see CONTRIBUTING rule)
- [ ] `npm run check` passes
- [ ] `npm run test` passes
- [ ] `npm run test:smoke` passes (headless, provider stubbed at the network layer)
- [ ] `npm run build` succeeds
- [ ] Code follows the project's coding standards
- [ ] Self-reviewed my changes
- [ ] Comments added for non-obvious logic
- [ ] Documentation updated (if applicable)
- [ ] No `console.log` in production code

## Screenshots (if applicable)

<!-- Add screenshots for UI changes -->

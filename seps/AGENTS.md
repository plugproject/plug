# SEP directory instructions

Whenever a SEP file in this directory is added, removed, renamed, retitled, or
changes status, rebuild the proposal index in README.md between the
`sep-index:start` and `sep-index:end` markers so it matches each file's
frontmatter exactly; the `update-seps-readme` skill in `.agents/skills/`
documents the procedure. Then run `npm run generate:seps` (rendered pages are
committed) and `npm run check:docs`.

Never invent PR numbers, sponsors, or approvals. Proposals keep template.md's
section order. Final behavior SEPs must link regression tests under
`../tests/`. Valid statuses: draft, in-review, accepted, final, rejected,
withdrawn, superseded, dormant.

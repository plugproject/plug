---
name: update-seps-readme
description: >-
  Rebuilds the proposal index in seps/README.md from the SEP files' frontmatter.
  Use whenever a SEP in seps/ is added, removed, renamed, retitled, or changes
  status — including when a 0000 file is renamed to its PR number — or when the
  user asks to update the SEP index, SEP list, or seps/README.md.
---

# Update the SEP index in seps/README.md

`seps/README.md` carries an index of every proposal. It goes stale the moment a
SEP file is added, renamed, retitled, or changes status. This skill rebuilds
the index from the SEP files; it never edits the SEP files themselves.

## Source of truth

The SEP files are authoritative, never the existing index. A SEP file is any
`seps/` file matching `NNNN-*.md` (four digits, then a slug) — `README.md` and
`template.md` are not SEPs. Each file's frontmatter `title` and `status` must
be copied into the index exactly. Valid statuses: `draft`, `in-review`,
`accepted`, `final`, `rejected`, `withdrawn`, `superseded`, `dormant`.

## Rebuild procedure

1. List the SEP files sorted by filename (PR number first, then slug):

   ```sh
   ls seps/[0-9]*.md
   ```

2. Read `title` and `status` from each file's frontmatter.

3. In `seps/README.md`, replace everything between the markers

   ```
   <!-- sep-index:start -->
   <!-- sep-index:end -->
   ```

   with a single table, one row per SEP in the order from step 1:

   ```markdown
   | SEP  | Proposal            | Status     |
   | ---- | ------------------- | ---------- |
   | NNNN | [<title>](filename) | `<status>` |
   ```

   `NNNN` is the filename's four-digit prefix. Do not edit anything outside
   the markers. Do not invent PR numbers, reviewers, or statuses.

4. Format, then validate:

   ```sh
   npx prettier --write seps/README.md
   npm run check:docs
   ```

   `check:docs` fails on broken links. If it names a link you just wrote, fix
   the index entry — never rename a SEP file to satisfy the index.

5. If SEP files changed (not just the index), regenerate the committed rendered
   pages:

   ```sh
   npm run generate:seps
   ```

## Renaming 0000 to a PR number

Renaming a SEP file changes both the row's `SEP` column and its link target.
Rebuild the row, keep the title verbatim, and let `npm run check:docs` confirm
nothing else in `seps/` or `docs/` still links to the old filename.

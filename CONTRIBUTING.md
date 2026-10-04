# Contributing to Plug

Use Node 24 and `npm ci`. Develop the specification and implementation together.
Canonical serialized types live in `schema/draft/schema.ts`. Generated files are
`schema/draft/schema.json`, `schema/draft/validators.js` and its declaration, `docs/specification/draft/schema.mdx` and `docs/seps/*.mdx`.
Edit sources and run `npm run generate`; never resolve generated conflicts by hand.

Run `npm run check`, `npm run build`, and `npm run test:browser`. `npm run format`
formats sources; `npm run check:format` checks formatting. `npm run serve:docs` opens
a local documentation preview; the same tree has Mintlify navigation.

Use [SEPs](seps/README.md) for major behavior, contract or process changes. Bug fixes
and clarifications need ordinary pull requests with regression evidence. Describe
observable behavior and test results. Do not invent production guarantees or weaken
user requirements to make a candidate pass. Owner licensing remains unresolved.

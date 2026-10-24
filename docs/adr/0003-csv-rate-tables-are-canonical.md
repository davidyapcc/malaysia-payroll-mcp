# Rate tables are CSV files, and the code that reads them is generated and committed

The official rate tables are transcribed into CSV files, one per table and effective date (`docs/data/`). These CSVs are the only source of truth. A script turns them into typed TypeScript modules, and the generated modules are committed. CI reruns the script and fails if the output differs.

We chose this over hand-written JSON or TS (two copies that drift apart) and over reading the CSVs at runtime (file I/O breaks bundling, npx and Cloudflare Workers). Committing the generated files keeps rate changes reviewable as a plain diff, and tests run without a build step.

## Consequences

- To change a rate, edit the CSV and rerun the script. Never edit a generated module by hand: CI will reject it.
- A new effective date is a new CSV, never an edit to an existing one, so older pay periods keep their results.

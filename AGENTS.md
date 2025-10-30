AGENTS.md — Project agent instructions

Build / Run
- Install deps: npm install
- Start (production): npm start
- Start (dev): npm run dev
- Health: GET /healthz

Checks / Tests
- Syntax check: npm run check
- Basic self-test: npm run test
- Lint/format placeholders: npm run lint / npm run fmt

Code style
- Use ES module syntax (import/export). Project "type": "module".
- Keep server-side JS small and explicit; prefer async/await and try/catch.
- Parameterize all SQL queries (no string interpolation into SQL).
- Limit DB connections: use pooled queries and close clients after use.
- Errors: log server-side (timestamps) and return non-sensitive messages to clients.
- Names: snake_case for DB columns, camelCase for JS variables.
- File structure: public/ for front-end assets; server.js at project root.
- Tests: add simple integration tests under scripts/ and reference them from `npm run test`.

Agent behavior
- If editing DB schema, run ensureSchema() at startup or provide migration scripts.
- If adding new dependencies, update package.json and include install step.

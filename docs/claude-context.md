# Opentrack: project context

Opentrack is a self-hosted, open-source Jira alternative.
It is the public, unbranded copy of a private team tracker, published under the MIT license.

## Stack

- API: Hono (`server/app.js`), one route module per area in `server/routes/`, shared logic in `server/lib/`.
- Hosts: Cloudflare Workers + D1 (`server/worker.js`, `wrangler.toml`) and Node (`server/node.js`) with Postgres (`DATABASE_URL`) or SQLite (`SQLITE_PATH`).
- SQL runs unchanged on SQLite and Postgres; migrations live in `migrations/` (D1 applies them with `npm run db:migrate`, Node applies them on start).
- Web app: Vue 3, Vue Router, Tailwind 4 (`src/`); theme tokens in `src/style.css` (indigo accent, Geist and Geist Mono from `@fontsource-variable`).
- Code shared by both sides: `shared/`.
- Tests: Vitest with `node:sqlite` in memory (`test/`, helpers in `test/helpers.js`), including client tests that mount components.

## Key concepts

- Workspace roles: admin, member, viewer, guest; project roles in `project_members`; rules in `server/lib/access.js`.
- Sessions use the `it_session` cookie and require the `X-Requested-With: opentrack` header on writes; API tokens and OAuth tokens start with `otk_`.
- MCP server at `/mcp` (`server/mcp.js`) for AI assistants.
- Scheduled work runs from ordinary requests (`server/lib/jobs.js`), not cron.
- Public demo mode (`DEMO_MODE=true`, `server/lib/demo.js`): a shared demo account with the admin role that can read every admin page but not change admin settings, its own account or webhooks. Checked in `markDemo` and `requireAdmin` in `server/lib/session.js`.

## Deploy

- One-click buttons in `README.md`: Deploy to Cloudflare (reads `wrangler.toml`, `.dev.vars.example`, `package.json` `cloudflare.bindings`, runs `build` then `deploy`) and Run on Google Cloud (`Dockerfile`, `app.json`).
- Personal deployments keep their own config in an ignored `wrangler.<name>.toml` and deploy with `-c`.

## Commands

- `npm test`, `npm run lint`, `npm run format:check`, `npm run build`.
- `SETUP_TOKEN=dev npm run dev:api` plus `npm run dev` for local work.

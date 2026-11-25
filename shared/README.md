# shared/

Pure modules imported by both the web app (`src/`, bundled by Vite) and the Worker (`server/`, bundled by Wrangler).
Rules that must agree on both sides live here once: issue type and priority ids, workflow transitions, CSV cell
escaping, RAID statuses and scoring.

Rules for files in this folder: no imports from `src/` or `server/`, no Vue, no D1, no DOM or Workers APIs. Labels and
colours that only the browser shows stay in `src/`.

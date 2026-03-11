# AGENTS.md

## Documentation Split

- `README.md` is the public-facing document — keep it **simple and concise** so users can understand the project quickly.
- `NOTES.md` is the local-only detailed reference (git-ignored) — put all **technical internals, implementation details, and deep explanations** here.
- When adding or changing documentation, decide which file it belongs in based on audience: quick-start user → `README.md`, developer digging into internals → `NOTES.md`.
- When updating code behavior that is documented in `NOTES.md`, update `NOTES.md` in the same task.

## Frontend And Design Sync

- When changing frontend UI, UX, layout, interaction, visual styling, copy, or information architecture in files such as `index.html`, `styles.css`, `app.js`, or other user-facing frontend assets, update the related Pencil design file in the same task.
- Treat the Pencil design as part of the deliverable, not a follow-up item.
- If a Pencil update is blocked by tooling or connectivity, explicitly report that blocker in the final response instead of silently skipping the design sync.

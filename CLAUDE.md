# HomeFlix

Personal home media server: a MacBook hosts a folder of videos and photos, a
Smart TV on the same Wi-Fi opens a lightweight web app to browse and play them.

Read `docs/ARCHITECTURE.md` before changing anything. It is the contract
between the server, the Mac control panel and the TV app.

## Rules

### Commits
- Conventional Commits 1.0: `type(scope): summary` (imperative, lowercase, no
  trailing period, ~72 chars max), then a body explaining why.
- Scopes: `server`, `admin`, `tv`, `launcher`, `docs`, `test`, `repo`.
- Never add `Co-Authored-By` or any other trailer or text naming Claude or any
  AI tool, in commits or pull requests. Commits are authored by the user only.
- One logical change per commit. Never push unless asked.

### Code
- Zero runtime npm dependencies. Node built-ins only; third-party code is
  vendored under `server/vendor/` with its license. No build step.
- No internet at runtime: no CDNs, web fonts or remote images. Everything the
  TV loads comes from the Mac.
- `web/tv/` must run on old Smart TV browsers: ES5 syntax only (no arrow
  functions, `let`/`const`, template strings, classes, `fetch`, Promises,
  modules, optional chaining), no CSS grid `gap` on flexbox, no `backdrop-filter`
  reliance. `web/admin/` runs in a current desktop browser and may use modern JS.
- The media server is LAN-only: requests from non-private addresses are refused.
  Anything that writes, deletes or changes settings lives on the loopback-only
  control server, never on the LAN one (playback progress is the one exception).
- Never serve a path outside the configured library folders. Items are
  addressed by opaque id, never by client-supplied path.
- User-facing copy is plain language for non-technical people: no jargon, no
  stack traces, every error says what to do next.

### Verifying
- `npm test` must pass (Node's built-in test runner).
- For UI changes, run `npm start` and look at the real page; the TV app must be
  fully usable with arrow keys, Enter and Backspace/Escape alone.

## Agent team
Role definitions live in `.claude/agents/`. Each owns one area and must not
edit another's files; cross-area changes go through `docs/ARCHITECTURE.md` first.

| agent | owns |
|-------|------|
| `backend-engineer` | `server/`, `bin/`, `test/` |
| `tv-ui-engineer` | `web/tv/` |
| `admin-ui-engineer` | `web/admin/` |
| `qa-reviewer` | reviews everything, read-only, reports findings |

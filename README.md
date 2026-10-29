# M2ordle

A daily class-portrait guessing game with the purple pixel arcade style of M2 Mogger. One classmate, five guesses, a new frame at midnight **America/Chicago**.

## Play

Type a first or last name, choose a roster entry, and submit it. Each wrong guess unlocks a larger, repositioned square crop. The fifth miss ends the game; either outcome reveals the full portrait. Progress is saved on the server under an anonymous browser token, so reloading keeps your guesses.

Results include personal stats, today's class guess distribution, a Central Time countdown, and a large copy button. Shared results contain exactly five colored squares. A first-guess solve earns 5 points, then 4, 3, 2, or 1. Unsolved games earn 0. Verified daily results add to the cumulative leaderboard; ties use wins, then average guesses (a loss counts as 6), then name.

## Schedule puzzles

Open `admin.html` and enter the owner password. Select a date in the calendar, select a grouped portrait or alternate pose, and choose the person's name from the roster. The portraits are deliberately **not automatically identified**. Set five square crops by dragging or using arrow keys and adjusting the crop-size slider. Later crops must be at least as wide as earlier crops; they may move to a different area of the photo. The full-photo reveal is generated automatically in the same square frame.

Save a draft or publish. Future days can be edited until somebody opens that day's live puzzle. A played puzzle is locked to keep scores consistent. If a day has no published puzzle, players see “Check again, or contact Devin to update today's M2ordle.” There is no event countdown on the home screen. Puzzle numbering starts at the earliest published day; calendar days after that continue numbering, including gaps.

The PDF supplies 181 accepted names and table assignments. The reviewed library has 183 photo groups containing 633 alternate images, all preserved. There is no assumption that its groups map one-to-one to PDF rows.

## Local development

Node 24 and pnpm 11 are used. From this folder:

```sh
pnpm install
pnpm dev
```

The local app runs at `http://127.0.0.1:8788`, and the editor at `/admin.html`. `.dev.vars` supplies a unique `ADMIN_PASSWORD` of at least 20 characters. The owner's local access note is stored in the ignored `private/admin-access.md` file.

The primary working copy also contains ignored imports: `server/roster.json`, `server/photos.json`, and `private/portraits`. Keep a private backup of these files and the supplied PDF; a public Git clone does not include them. `scripts/import-library.py` reproducibly imports the supplied PDF and reviewed photo library. Read its arguments before running it on another computer. No automated facial identity matching is involved.

```sh
pnpm check
pnpm test
pnpm build
```

Tests cover five-guess limits, scoring, idempotent requests, persistent state, duplicate claims, protected images, private data exclusions, authentication throttling, calendar locks, and the spring/fall daylight-saving transitions. Backend tests require the private imports.

## Deployment

GitHub Pages serves only the public frontend. A separate Cloudflare Worker, `m2ordle-api`, serves the API and protected portrait assets. A SQLite Durable Object named `m2ordle-class-of-2029-v1` stores puzzles, cropped JPEGs, games, verified scores, and throttles. M2 Mogger's Worker and rankings are independent.

```sh
# Build and deploy the backend from the complete local working copy:
pnpm deploy:api

# Set the private owner secret using Wrangler's input prompt:
pnpm exec wrangler secret put ADMIN_PASSWORD

# Produce the public GitHub Pages build without private imports:
M2ORDLE_API_URL=https://m2ordle-api.devinkancherlaawesome-bbc.workers.dev node scripts/build.mjs --static-only
```

GitHub Pages must use **GitHub Actions**, not branch/root publishing. The workflow publishes `dist/` on pushes to `main` or a manual dispatch. API and gameplay changes require a separate Worker deployment. Worker deployment embeds the private roster as server code; it is never a public static file.

The full source build writes `dist-worker/` with the public frontend plus `_portraits/`. Worker-first routing authenticates every original portrait request. Public `dist/` has no photos, roster tables, PDF, grouping metadata, passwords, or backend data. Gameplay returns only the currently unlocked cropped JPEG, with the answer and full reveal available after completion. The HTML uses noindex; robots directives are crawler preferences rather than access controls.

Table-number verification is the class check requested for the leaderboard, not strong personal authentication. Anyone who knows another student's table can potentially claim that name. Failed attempts are limited by session and IP; one result per name per day is enforced. Anonymous browser progress can be lost if browser storage is cleared, while already verified class scores remain on the server.

## Files

- `public/`: player and admin interfaces, CSS, pixel SVG, reusable name picker.
- `server/worker.js`: API, private asset authorization, SQLite data model.
- `server/core.js`: time-zone, crop validation, scoring, and stats logic.
- `scripts/build.mjs`: separate explicit public and protected build outputs.
- `scripts/import-library.py`: local roster/photo import and verification.
- `tests/`: server, build-privacy, and frontend utility tests.

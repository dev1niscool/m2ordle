# M2ordle

A daily class-portrait guessing game with the purple pixel arcade style of M2 Mogger. One classmate, five guesses, a new frame at midnight **America/Chicago**.

## Play

Type a first or last name, choose a roster entry, and submit it. Lookbook puzzles start with the classmate's first fun fact on guess 1, all three facts on guess 2, then three widening square photo crops on guesses 3–5. Classmates without matched facts retain five photo clues. The fifth miss ends the game; either outcome reveals the full portrait. Progress is saved on the server under an anonymous browser token, so reloading keeps your guesses.

All 181 accepted names and their roster IDs are committed in `public/classmates.js` and served with the site on GitHub Pages. Gameplay and result-name autocomplete use that bundle directly, without fetching a roster from the API. Table assignments and the daily answer remain server-side.

Results include personal stats, today's class guess distribution, a Central Time countdown, and a large copy button. Shared results contain exactly five colored squares. A first-guess solve earns 5 points, then 4, 3, 2, or 1. Unsolved games earn 0. Verified daily results add to the cumulative leaderboard; ties use wins, then average guesses (a loss counts as 6), then name.

Unpublished Saturdays and Sundays preserve streaks without adding wins: a Friday streak carries through a closed weekend into Monday, and solving Monday adds one. Published weekend puzzles still count, so missing or losing one breaks the streak. Weekday gaps keep their usual behavior. Current and best streaks are calculated from saved games and the published schedule in Central Time.

Anyone can view the cumulative classwide leaderboard from the homepage, without starting or finishing a puzzle or verifying a name. Adding a score still requires a completed game and table-number verification; both solved and unsolved completed games qualify. Returning browsers highlight and scroll to the classmate from their most recent verified result, even on a new day.

## Schedule puzzles

Open `admin.html` and enter the owner password. Select a date in the calendar, select a grouped portrait or alternate pose, and choose the person's name from the roster. An asterisk marks classmates with three matched lookbook facts; selecting one automatically shows their facts and switches the editor to three crops for guesses 3–5. Other names use five crops. The portraits are deliberately **not automatically identified**. Set the square crops by dragging or using arrow keys and adjusting the crop-size slider. Later crops must be at least as wide as earlier crops; they may move to a different area of the photo. Preview steps through all five clues and the full-photo reveal.

Each saved lookbook puzzle stores its own three-fact snapshot, so future imports cannot change a puzzle already being played. Existing five-photo puzzles retain their format; reselect the starred name on an unplayed day to switch it to lookbook clues. Copying a saved puzzle preserves its clue format and facts.

Save a draft or publish. Future days can be edited until somebody opens that day's live puzzle. A played puzzle is locked to keep scores consistent. If a weekday has no published puzzle, players see “Check again, or contact Devin to update today's M2ordle.” On Saturdays and Sundays without a published puzzle, they see “M2ordle is closed for the weekend” and a reminder to come back Monday. Weekend dates follow Central Time, and published weekend puzzles remain playable as usual. There is no event countdown on the home screen. Puzzle numbering starts at the earliest published day; calendar days after that continue numbering, including gaps.

The control room also includes:

- **Schedule overview:** the next 14 Central Time dates, their published/draft/missing status, and a shortcut to the next day that needs a published puzzle.
- **Day activity:** started games, completions, win rate, average guesses among wins, and verified leaderboard entries for the selected date. Started games count browser sessions, not verified individual people.
- **Player preview:** step through the five current crops and the full reveal before saving. It includes unsaved crop edits and never creates a game or score.
- **Copy to another day:** duplicate a saved puzzle and all six images to an empty current/future date as a draft. This works for locked source puzzles too; it cannot overwrite an existing destination or change the source puzzle.
- **Month export:** download the displayed calendar month as a CSV, including empty dates. It contains schedule details, not table assignments, credentials, or portrait images.

Played days are visibly locked in the editor; preview and copying remain available. Existing saved puzzles and player results are preserved.

The PDF supplies 181 accepted names and table assignments. The reviewed library has 183 photo groups containing 633 alternate images, all preserved. There is no assumption that its groups map one-to-one to PDF rows.

## Local development

Node 24 and pnpm 11 are used. From this folder:

```sh
pnpm install
pnpm dev
```

The local app runs at `http://127.0.0.1:8788`, and the editor at `/admin.html`. `.dev.vars` supplies a unique `ADMIN_PASSWORD` of at least 20 characters. The owner's local access note is stored in the ignored `private/admin-access.md` file.

The primary working copy also contains ignored imports: `server/roster.json`, `server/photos.json`, `server/lookbook.json`, and `private/portraits`. Keep a private backup of these files and the supplied PDFs; a public Git clone does not include them. `scripts/import-library.py` reproducibly imports the class roster and reviewed photo library. Read its arguments before running it on another computer. No automated facial identity matching is involved.

The lookbook importer matches written names and reviewed aliases, preserving the three numbered fun facts in their original order. Run `python3 scripts/import-lookbook.py` with `pypdf` installed to regenerate `server/lookbook.json` from `Lookbook/Lookbook.pdf`; its detailed matching report is saved privately in `private/lookbook-match-report.md`. The current import contains 149 matched classmates (126 exact/normalized names and 23 reviewed aliases); 32 roster members have no matched lookbook page. Five lookbook names are absent from the accepted roster and are excluded. The full build validates the private import; the public Pages build requires none of it.

After importing or editing `server/roster.json`, run `node scripts/export-classmates.mjs` and commit the updated `public/classmates.js`. The exporter includes only IDs and names. A full build checks that this public bundle matches the server roster; a static Pages build uses the committed bundle and does not need private imports.

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

GitHub Pages must use **GitHub Actions**, not branch/root publishing. The workflow publishes `dist/` on pushes to `main` or a manual dispatch. API and gameplay changes require a separate Worker deployment. Worker deployment embeds the full roster, including table verification data, as server code; only the names and IDs are published in `classmates.js`.

The full source build writes `dist-worker/` with the public frontend plus `_portraits/`. Worker-first routing authenticates every original portrait request. Public `dist/` has no photos, roster tables, PDFs, lookbook facts, grouping metadata, passwords, or backend data. Full facts are accessible only in the password-protected admin roster. Gameplay returns only the facts or cropped JPEG earned for that guess; photo URLs are denied during fact-only guesses, with the answer and full reveal available after completion. The HTML uses noindex; robots directives are crawler preferences rather than access controls.

Table-number verification is the class check requested for the leaderboard, not strong personal authentication. Anyone who knows another student's table can potentially claim that name. Failed attempts are limited by session and IP; one result per name per day is enforced. Anonymous browser progress can be lost if browser storage is cleared, while already verified class scores remain on the server.

## Files

- `public/`: player and admin interfaces, CSS, solid pixel wordmark, original pixel mascot share artwork and app icons, reusable name picker.
- `server/worker.js`: API, private asset authorization, SQLite data model.
- `server/core.js`: time-zone, crop validation, scoring, and stats logic.
- `scripts/build.mjs`: separate explicit public and protected build outputs.
- `scripts/import-library.py`: local roster/photo import and verification.
- `scripts/export-classmates.mjs`: exports the public name bundle from the private roster, excluding table assignments.
- `scripts/import-lookbook.py`: matches written lookbook names to roster IDs and imports the three labeled facts privately.
- `tests/`: server, build-privacy, and frontend utility tests.

Typography uses self-hosted [Pixelify Sans](https://github.com/google/fonts/tree/main/ofl/pixelifysans), Copyright 2021 The Pixelify Sans Project Authors. The SIL Open Font License is shipped in `public/assets/PixelifySans-OFL.txt`; the SVG wordmark uses its bold glyph outlines.

The small `M2ordle Pixel Digits` font overrides only 2 and 5: the 2 has a stepped diagonal and flat base, while the 5 has a flat top and open sides. The logo uses the same clearer 2. The override preserves the original digit widths and weight range, and uses the same OFL license. Rebuild its committed WOFF2 and logo numeral with `python scripts/make-digit-font.py` after installing `fonttools[woff]`; normal site builds use the committed assets.

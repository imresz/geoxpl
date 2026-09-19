# GeoXpl

An initial working implementation of [Initial requirement 01092026.txt](docs/Initial%20requirement%2001092026.txt).

GeoXpl opens on a map of southeastern Australia. Enter a feature name, select **River** or **Valley**, and search. Names are case-insensitive. The catalogue starts empty. Every new request creates a persistent job; the browser waits up to five seconds, then invites the user to return later while work continues. Repeated searches reuse the same job.

## What works

- MapLibre map, OpenStreetMap basemap, Victoria outline, pan/zoom, feature fit and provenance panel.
- Persistent feature catalogue, jobs, research reports, source registry, usage counts and audit events in SQLite.
- Password-protected administration at `/admin`, with source and research approval/rejection, editable source settings, job retry and processing activity.
- Named-feature import from approved ArcGIS layers and HTTPS GeoJSON collections. Raw import snapshots, checksums, source IDs and derivation history are retained.
- Per-feature approved aliases and source selection; conservative river identity, connectivity and branch checks; published valley polygon import.
- Optional OpenAI web research producing structured recommendations and candidate sources. AI calls are rate limited. New sources require separate approval.
- Without AI credentials, the worker produces an explicit configuration report. For rivers it can inspect a known official Vicmap Hydro catalogue entry and propose it for review. This is a catalogue lookup, not AI research.

## Current limits

This is a local pilot, not yet a general geographic inference engine. It does not invent missing geometry. It now extracts geometric main-stem candidates, but does not implement automated hydrological adjudication, flow direction inference, terrain-derived valleys or interactive selection between distinct same-named features within the pilot region. Disconnected or branching networks and multiple matching valley polygons remain partial until sufficient geographic evidence exists. Source and mouth are left unset until evidence establishes their meaning. Line geometry means a feature's path, not turn-by-turn navigation.

Each source is processed independently. River components must intersect Victoria or its 2 km border tolerance; connected reaches are retained beyond the border, not clipped. Additional components within 100 metres of selected endpoints can be associated as possible continuations, but their gaps remain unchanged and the result stays partial. Remote disconnected namesakes are excluded. Identity decisions and excluded-record counts are retained in the feature's processing evidence. This is conservative eligibility checking, not proof of river identity or completeness.

Only one dataset supplies a feature's displayed geometry and length. Automatic selection prefers a resolved candidate, then the candidate with the widest geographic span. Administration can override this per feature. Other sources remain comparisons; overlapping national and regional representations are never added together. A failed comparison download does not invalidate a complete result from a different selected source. A failed explicitly selected source does not silently fall back to another dataset.

Only a connected, unbranched river path or a single valid polygon from a source explicitly reviewed as supplying complete named features can be published as resolved. Partial geometry is stored and can be inspected by choosing **View available geometry**; it is never automatically shown as a complete feature. Do not mark a regional river dataset complete merely to bypass this check. A first Murray River search may need several approved datasets and further processing capability before a full result is possible.

The simplified Victoria outline is from geoBoundaries, CC BY 4.0; exact metadata is in `public/boundary-source.json`. Its scope checks are suitable for this pilot, not cadastral or border-sensitive decisions. The catalogue and source registry initially contain no approved feature data. A source catalogue URL in the researcher is a discovery hint only.

## Local deployment (Windows, macOS or Linux)

Requires **Node.js 24 LTS** and npm. Run from the repository root:

```powershell
cd C:\Git\geoxpl
npm ci
npm run build
npm test
npm run dev
```

Open **http://127.0.0.1:4173**. Open **http://127.0.0.1:4173/admin** and create a password of at least 12 characters. First-run browser setup is available only with a loopback-bound server. `npm run admin:password` also sets or resets the password using a masked terminal prompt, and revokes existing sessions.

For production assets, use `npm start` after `npm run build`. Both commands serve the frontend and API from one port. Set `PORT` in `.env` to choose another port. Run only **one application instance** against each database; the worker is embedded in the server. Closing the browser does not stop jobs. Stopping the server pauses processing; interrupted active jobs are retried at the next start.

Persistent local data is in `runtime/geoxpl.sqlite` and its SQLite journal files. It is excluded from Git. The requirement document and its existing edits are not replaced by this implementation.

## AI configuration

Copy `.env.example` to `.env` and set:

```dotenv
PORT=4173
HOST=127.0.0.1
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=your-web-search-and-structured-output-capable-model
AI_REQUESTS_PER_HOUR=3
```

Select a model available to your API account that supports the Responses API, web search, and structured outputs. There is deliberately no silently selected model. Restart the app after changes. `/admin` shows whether both required values are configured; it does not test API credentials. Keys remain on the server and are never sent to the browser or stored in research reports. API usage may incur charges.

AI receives the feature name/type, processing gaps and registered source metadata. It returns evidence links, recommendations and candidate source settings. It cannot approve datasets, supply geometry or execute generated code. Approving a missing-capability recommendation records the decision; implementing a new algorithm still requires development work. See the official [web search](https://developers.openai.com/api/docs/guides/tools-web-search) and [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) documentation.

## First search and source approval

1. Search for `Murray River` with type `River`.
2. If no approved data is available, the job produces a research/configuration report. The public view asks the user to retry later.
3. Open `/admin`, inspect **Research**, then **Source registry**.
4. Review a candidate or add a source. Provide a specific ArcGIS layer URL ending in its numeric layer ID, or an HTTPS WGS84 GeoJSON FeatureCollection; configure its name and object-ID fields.
5. Verify and enter licence and attribution. Leave completeness as partial/unknown unless the source actually supplies entire named features. Approve the source.
6. Changed source approvals queue relevant waiting requests. Under **Requests**, open the feature-settings control to approve feature-specific aliases and optionally choose the geometry source. Saving changed settings queues processing. Suggested aliases come from that feature's research reports, not from global source aliases.
7. Repeat the original search. A resolved result is displayed and fitted on the map; incomplete work remains pending or partial.

**Mark reviewed** records a research decision; it does not execute recommendations or retry the job. Reviewing the latest report moves a waiting request to **Needs geographic evidence**, retaining its current outcome and geometry. Older reports cannot change the current processing stage. **Retry** checks the sources again, but reuses research for unchanged selected-source evidence. Outages or changes in comparison-only sources do not demand another review. Unchanged raw snapshots are reused. **New research** explicitly requests a fresh report and confirms possible API charges. Source approval remains separate.

### Main-stem candidates

For branching river networks, the processor now builds a distance-weighted graph from exact shared coordinate vertices. It compresses degree-two chains, uses Graphology's Dijkstra routing, and selects the longest of the shortest routes between open endpoints in each connected component. This removes side branches and chooses shorter alternatives through braids. Routing is bounded at 250,000 vertices overall, and 128 endpoints / 512 junctions per component; closed networks or larger graphs remain unresolved with an explicit reason.

This is a **geometric candidate**, not a verified hydrological main stem. The longest endpoint route can choose the wrong headwater or distributary; the shortest braided route can choose the wrong channel. No flow direction, source or mouth is inferred as fact. No coordinate snapping, intersection noding, lake connectors, gap bridging or cross-source stitching is performed. Separate components remain separate. Evidence refers only to records contributing to the candidate; original imports and the full named network remain available. In the map, switch between **Main-stem candidate** and **Named network**. Measurements refer to the selected view, not a certified river length.

A candidate stays partially resolved and out of the resolved catalogue, even when the source's coverage is marked complete. Candidate processing stops at **Needs geographic evidence** without automatically creating another AI report. Explicit **New research** remains available. Verified branch/flow evidence, endpoint identification and source-backed missing connectors are the next requirements for a publishable source-to-mouth route.

Imports use exact case-insensitive matching of the submitted name and approved aliases for that feature. Sources must use public HTTPS addresses; private network URLs, redirects and oversized responses are rejected. ArcGIS imports union object IDs across names and retrieve at most 100 records per batch, shortening batches further to keep request URLs within 1,800 characters. Imports are limited to 25,000 records; GeoJSON responses are limited to 20 MB. Import limits and unsupported formats produce reviewable failures.

## Ubuntu deployment with Docker Compose

Install Docker Engine and the Compose plugin using [Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/). Clone this repository and run:

```bash
cd geoxpl
cp .env.example .env
# Edit .env for AI configuration, if required.
docker compose build
docker compose run --rm app node scripts/admin-password.js
docker compose up -d
docker compose logs -f app
```

The app is reachable on the server at `127.0.0.1:4173`; it is not exposed publicly by Compose. From another machine, use an SSH tunnel:

```bash
ssh -L 4173:127.0.0.1:4173 your-user@your-server
```

Then open `http://127.0.0.1:4173` on that machine. The named volume `geoxpl-data` stores jobs, source imports, reports and passwords. `docker compose down` preserves this volume; do not use `down -v` unless intentionally deleting all application data.

For a public deployment, put an HTTPS reverse proxy in front of port 4173, preserve the Host header, and set `SECURE_COOKIES=true` in `.env`. Browser administrator setup stays disabled in the container. Review the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/) and choose an appropriate tile provider before increasing traffic. The current provider URL is in `src/MapView.tsx`; rebuild after changing it. Public OSM tiles do not support bulk/offline downloads or guaranteed availability.

## Ubuntu deployment without Docker

Install Node.js 24 LTS from an official distribution. Place the repository in `/opt/geoxpl` and create a service account:

```bash
sudo useradd --system --home /opt/geoxpl --shell /usr/sbin/nologin geoxpl
cd /opt/geoxpl
npm ci
npm run build
npm test
sudo install -d -o geoxpl -g geoxpl /opt/geoxpl/runtime
sudo -u geoxpl npm run admin:password
sudo cp deploy/geoxpl.service /etc/systemd/system/geoxpl.service
sudo systemctl daemon-reload
sudo systemctl enable --now geoxpl
sudo journalctl -u geoxpl -f
```

The service file assumes Node is `/usr/bin/node`. Check `command -v node` and adjust `ExecStart` when necessary. Make `.env` readable by `geoxpl` and restrict other access if it contains credentials. Set `ALLOW_ADMIN_SETUP=false` before placing the application behind a public reverse proxy. Use the SSH tunnel or HTTPS proxy arrangement above.

## Updating and backups

Stop the single app instance before a filesystem backup; copy the entire `runtime` directory, not just one live SQLite file. For Docker, stop the service and back up the named volume with your normal Docker-volume backup procedure. Back up `.env` separately in a secure location.

After updating code, run `npm ci`, `npm test` and `npm run build`, then restart the systemd service; or use `docker compose up -d --build`. The additive `feature_settings` table is created automatically on startup without changing existing source approvals, reports or imports. Reprocess older features to apply the source-selection and identity checks. Source approval changes invalidate dependent published features and retain prior derivations/import snapshots.

## Structure and checks

```text
src/           React map, search and administration
server/        API, SQLite store, worker, importers, processors, AI research
scripts/       Administrator password and reproducible boundary download
tests/         Job, approval, import, security and geographic regression checks
public/        Open-licensed Victoria outline and its provenance
deploy/        Example Ubuntu systemd service
```

`npm test` runs offline regression tests with explicitly synthetic test geometry. `npm run build` type-checks the frontend and builds static assets. `GET /api/health` reports service readiness. `npm run boundary:download` refreshes the map outline from geoBoundaries and rewrites its provenance manifest; review changes before committing.

The implementation uses Node/React/SQLite to keep the first pilot deployable as one process. PostGIS, distributed queues, terrain processing and automated source-update sweeps are not required to run this version and have not been added. This README describes the implementation; the dated requirement remains the product specification.

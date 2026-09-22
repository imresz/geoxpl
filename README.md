# GeoXpl

An initial working implementation of [Initial requirement 01092026.txt](docs/Initial%20requirement%2001092026.txt).

GeoXpl opens on a map of southeastern Australia. Enter a feature name, select **River** or **Valley**, and search. Names are case-insensitive. The catalogue starts empty. Every new request creates a persistent job; the browser waits up to five seconds, then invites the user to return later while work continues. Repeated searches reuse the same job.

## What works

- MapLibre map, OpenStreetMap basemap, Victoria outline, pan/zoom, feature fit and provenance panel.
- Persistent feature catalogue, jobs, research reports, source registry, usage counts and audit events in SQLite.
- Password-protected administration at `/admin`, with source and research approval/rejection, editable source settings, job retry and processing activity.
- Named-feature import from approved ArcGIS layers and HTTPS GeoJSON collections. Raw import snapshots, checksums, source IDs and derivation history are retained.
- Per-feature approved aliases and source selection; conservative river identity, connectivity and branch checks; published valley polygon import and reviewed [partial valley-floor estimates](#partial-valley-floor-estimates).
- BoM Geofabric directed river routes, with published headwater/terminal nodes, flow decisions and source-record provenance.
- Same-named feature selection: separate geometry, location labels and stable saved IDs for each evidenced identity.
- Optional OpenAI web research producing structured recommendations and candidate sources. AI calls are rate limited. New sources require separate approval.
- Without AI credentials, the worker produces an explicit configuration report. For rivers it can inspect a known official Vicmap Hydro catalogue entry and propose it for review. This is a catalogue lookup, not AI research.

## Current limits

This is a local pilot, not yet a general geographic inference engine. It keeps recorded geometry separate from dotted, interpolated estimates. It can follow published BoM Geofabric flow connectivity and recognise evidenced tributary confluences, or extract an unverified geometric main-stem candidate from other river datasets. It does not infer flow direction from terrain, derive complete ridge-to-ridge valley boundaries, or identify mouths behind arbitrary unnamed connectors. Unresolved gaps and branch choices remain partial. Endpoint labels explicitly distinguish BoM network nodes from independently surveyed physical source/mouth positions. Line geometry is not turn-by-turn navigation.

Each source is processed independently. River components must intersect Victoria or its 2 km border tolerance; connected reaches are retained beyond the border, not clipped. For generic named networks, additional components within 100 metres of selected endpoints can be associated as possible continuations; recorded gaps remain unchanged even when a separate dotted estimate is displayed. The Geofabric adapter follows published node connectivity; mismatched endpoint coordinates now produce separate recorded sections and an interpolation candidate, never resolved geometry. Remote disconnected namesakes are excluded. Identity decisions and excluded-record counts are retained in the feature's processing evidence. Geographic eligibility alone is not proof of river identity or completeness.

Only one dataset supplies a search's displayed geometries and measurements. For a single identity, automatic selection prefers a resolved candidate, then the candidate with the widest geographic span. Same-name selection has the identity-evidence priority described below. Administration can override the dataset per search. Other sources remain comparisons; overlapping national and regional representations are never added together. A failed comparison download does not invalidate a complete result from a different selected source. A failed explicitly selected source does not silently fall back to another dataset.

### Same-named features

A search can own several processed features. When the selected dataset identifies multiple in-scope matches, processing stores them all and the public search returns a location-labelled selection list, not an arbitrarily chosen river. Selecting an entry loads its geometry and provenance; **Matching features** returns to the list. Repeat searches reuse the list without another AI call. Each entry keeps its own resolution status and estimates. Partial entries can be selected but remain outside the resolved-only Catalogue tab.

Geofabric separates named routes that do not share named network nodes. Starting routes that join the same named network remain competing headwaters of one partial identity, not separate rivers. Other datasets can identify separate rivers or valleys using published `vicnames_id`, `named_feature_id` or `hydronameoid` fields, when every returned record has a valid positive ID in that field. Per-segment object IDs and disconnection alone are not evidence of distinct named features. Dotted gap processing runs only after identity separation and cannot automatically join different matches.

When multiple identities are discovered, automatic dataset selection prioritises directed-network identity evidence, then published feature IDs, ahead of an undifferentiated named network. Within that tier it prefers all-resolved results, fewer warnings per result, then the widest individual span. This selects one coherent dataset, not one source per fragment. An explicit source override still wins; a source with limited identity coverage can therefore expose fewer matches. General cross-dataset identity reconciliation and arbitrary semantic disambiguation are not implemented.

Labels combine the requested name with the western/eastern half of the Victoria scope outline and a receiving-river name when the confluence is evidenced. Extent-centre coordinates are shown beneath; coordinate/identity suffixes distinguish otherwise identical labels. These broad location descriptions are calculated from geometry, not gazetted regional names. They are not proof of endpoints or full extent. No Avon-specific name, geometry or regional shortcut is embedded in the processor.

The API returns `matches` (small summaries), `selectionRequired`, and `feature` (only for a single active result). Full geometry is retrieved with `GET /api/features/:id`. Job status describes whether all matches are resolved; selecting a partial entry does not approve it. The SQLite feature table migrates automatically on startup to one row per `(job_id, identity_key)`, retaining legacy data and derivation history. Save operations replace the active result set transactionally; stable publisher identity keys preserve IDs across ordinary retries. Superseded combined results and invalidated source results are retained for audit but excluded from public searches, catalogue and direct feature fetches. Changing dataset identity namespaces can create new IDs.

Generic imports require a connected, unbranched river path or a single valid polygon from a source explicitly reviewed as supplying complete named features before publication as resolved. Geofabric uses the feature-level network checks below instead, and publishes qualified **derived network routes**, not surveyed extents. An explicitly partial source still prevents resolution. Results with interpolations open on the map automatically, labelled **Partially resolved**. Other partial geometry can be inspected using **View available geometry**. Do not mark a regional dataset complete merely to bypass a check.

### Interpolated gaps

Gaps in geographic information may be represented by **dotted, straight-line estimates between located anchors**. The map legend distinguishes solid recorded geometry from dotted **Interpolated (unverified)** connections, with a checkbox to hide estimates. Individual connections can be selected in the feature panel to zoom in. Their distances are shown separately and never added to recorded river length or polygon area. A feature with estimates remains partial and outside the resolved catalogue. Ordinary processing does not request another AI report solely because an estimate exists.

For line features, the default processor joins nearby open endpoints of already-selected components, choosing shortest connections without cycles or reusing an endpoint. Automatic connections are limited to 5 km, 128 components, 256 open endpoints and 250,000 vertices. Geofabric coordinate gaps use the published node linkage instead of the nearest-endpoint heuristic. Located upstream alternatives are shown separately, not silently reduced to a chosen headwater. This display policy does not change geographic identity selection or import remote namesakes.

For any feature geometry, additional evidence-located anchor pairs can be retained in authenticated feature settings as `estimatedConnections`: `coordinates` (two WGS84 longitude/latitude pairs), `label`, `evidenceUrl` (HTTPS) and `evidenceRecord`. These are curated investigation data, not AI-generated coordinates. One anchor must lie within 1 metre of the current recorded geometry or boundary; stale pairs are omitted with a diagnostic. At most 32 pairs are accepted. Existing pairs survive an ordinary alias/source settings save, but changing feature identity/source selection clears them unless explicitly supplied again. Separate polygon parts are not automatically joined or filled because they may be legitimate disconnected areas.

For recorded features, the shared gap-overlay output is a GeoJSON `interpolations` collection, with an unverified classification, method, anchor references and per-connection distance. `displayBbox` includes the overlays; `geometry`, `bbox`, recorded length/area and verified endpoints retain their original meanings. `interpolationSummary.totalOverlayLengthKm` is the sum of displayed lines, including mutually exclusive alternatives, not a complete feature length. Unknown endpoint locations are not extrapolated arbitrarily. No feature names or coordinates are hard-coded in these rules. Derived valley polygons instead carry an `extentEstimate` classification: their entire displayed boundary and measured area are estimates, not recorded named-feature extents.

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

### BoM Geofabric routes

Configure the approved river source as follows. The AWDS catalogue/search page is a discovery page, not an import endpoint.

| Setting | Value |
| --- | --- |
| Format | ArcGIS |
| Layer URL | `https://hosting.wsapi.cloud.bom.gov.au/arcgis/rest/services/ahgf/Geofabric_V3x_All_Products/MapServer/6` |
| Name field | `name` |
| Object-ID field | `objectid` |
| Version | `3.3` |
| Licence | Creative Commons Attribution 4.0 International (CC BY 4.0) |
| Attribution | Commonwealth of Australia (Bureau of Meteorology) 2022 |
| Completeness | Unknown; evaluate the requested route, not all rivers globally |

The equivalent official `FeatureServer/6` URL also invokes this adapter. Supporting queries use the canonical `MapServer` service: endpoint nodes from layer `3` and preferred-flow records from table `37`. See the [BoM licence and access page](https://www.bom.gov.au/water/geofabric/download.shtml) and [product guide](https://www.bom.gov.au/water/geofabric/documents/v3_0/ahgf_productguide_V3_0_release.pdf). It uses the unfiltered **NetworkStream - All** layer, not the display layer that omits minor/unnamed connections.

For Murray River, approve the feature alias `River Murray` and select this source under the request's feature settings. Exact name matches seed the import; published `nextdownid` links add downstream records, including modelled waterbody connections. At a junction, continuity of the requested name takes priority over another named watercourse. Published preferred-flow IDs, then downstream IDs, resolve remaining choices. The processor never chooses a branch by shortest distance. These are explicit application rules applied to publisher data, not a publisher-certified main-stem designation.

Resolution requires exactly one named headwater route per identified river, known flow directions, consistent node IDs and coordinates, and a classified headwater. The downstream endpoint must be either a classified terminal node with an end-of-network marker, or a verified receiving-river confluence. Missing referenced records, cycles, ambiguous branches, competing headwaters within one river or gaps keep that result partial. At least 95% of route length must match the requested name/approved aliases; this conservative screen prevents long continuations through another river, but is not independent proof of identity. If that screen fails, a nonmatching downstream tail is excluded from displayed geometry and measurements, with its HydroIDs retained in diagnostics; the last named reach is not promoted to a verified mouth. There is no river-name or coordinate-specific shortcut in the processor.

For a potential confluence at the end of a named reach, the importer retrieves all immediate incoming and outgoing streams plus the junction point. The rule requires a published junction classification, exactly one outgoing receiving stream, and exactly one incoming stream bearing the same receiving-river name. Both that stream and the tributary must have downstream IDs pointing to the outgoing stream. Node IDs, known flow directions and the three stream endpoints must agree with the junction coordinates. A change of name alone is insufficient. If the requested name or an approved alias continues downstream, the river is not stopped there. Ambiguous junctions remain partial. Without a same-named receiving stream entering the junction, a name transition is not classified as a confluence; existing network-terminus and 95% named-length checks still apply.

A verified confluence ends the displayed route at the junction. The receiving river's upstream/downstream records are retained as `confluence_support` evidence, not added to the displayed geometry or length. Processing evidence records the termination rule and contributing HydroIDs. The endpoint panel displays **BoM river confluence** and the receiving river's name. This is a dataset-derived endpoint, not an independent survey.

When the named network starts at a junction rather than a classified headwater, the importer retains immediate incoming streams and their upstream nodes as identity evidence. The processor can show a **partial directed named reach**, but never chooses an unnamed headwater by length, catchment size or proximity. The `source` remains null; `mainStem.namedStart` identifies the beginning of the available reach, and `mainStem.headwater` lists upstream HydroIDs needing identity evidence. Supporting geometry is not appended to the route. Even a single unnamed upstream stream or a global completeness approval cannot remove this gap. These results remain outside the resolved catalogue and do not request another AI review automatically.

Imports are bounded at 10,000 route-network segments, 500 downstream expansion rounds, 128 potential confluences and 128 named starts (at most 10,000 adjacent supporting stream records), with supporting queries batched at 50 IDs. Raw geometry, endpoint records, upstream identity evidence, junction evidence and preferred-flow evidence are retained together in a checksum-covered version-3 snapshot. Every chosen segment and branch decision remains inspectable. No coordinates are snapped, bridged or added from another source. Older snapshots cannot establish evidence they never imported; retry imports that evidence using the approved source.

Resolved results have confidence `derived_published_network`. Both partial and resolved directed results show **km of BoM modelled flow path**; only supported endpoints get green/red markers. Geofabric's terrain-derived route, including waterbody connections, is not a surveyed river centreline or independently verified physical source-to-mouth boundary. A modelled terminus may differ from a named lake boundary. Its measured length can differ substantially from conventional published river lengths. Generic candidate processing below remains available for other sources. The [Avoca evidence review](docs/Avoca-river-evidence-review.md) records one such investigation, not additional processor rules.

### Generic main-stem candidates

For branching river networks, the processor now builds a distance-weighted graph from exact shared coordinate vertices. It compresses degree-two chains, uses Graphology's Dijkstra routing, and selects the longest of the shortest routes between open endpoints in each connected component. This removes side branches and chooses shorter alternatives through braids. Routing is bounded at 250,000 vertices overall, and 128 endpoints / 512 junctions per component; closed networks or larger graphs remain unresolved with an explicit reason.

This is a **geometric candidate**, not a verified hydrological main stem. The longest endpoint route can choose the wrong headwater or distributary; the shortest braided route can choose the wrong channel. No flow direction, source or mouth is inferred as fact. No coordinate snapping, intersection noding or cross-source stitching alters its recorded geometry. Separate components remain separate there; the interpolation overlay described above may connect them visually. Evidence refers only to records contributing to the candidate; original imports and the full named network remain available. In the map, switch between **Main-stem candidate** and **Named network**. The raw named-network view hides the candidate's estimates. Measurements refer to the selected view, not a certified river length.

A candidate stays partially resolved and out of the resolved catalogue, even when the source's coverage is marked complete. Candidate processing stops at **Needs geographic evidence** without automatically creating another AI report. Explicit **New research** remains available. A suitable directed dataset such as Geofabric can provide the additional flow, endpoint and connector evidence; changing an approval label alone cannot.

Named-feature imports use exact case-insensitive matching of the submitted name and approved aliases. Sources must use public HTTPS addresses; private network URLs, redirects and oversized responses are rejected. ArcGIS imports union object IDs across names and retrieve at most 100 records per batch, shortening batches further to keep request URLs within 1,800 characters. Imports are limited to 25,000 records; GeoJSON responses are limited to 20 MB. Import limits and unsupported formats produce reviewable failures.

### Partial valley-floor estimates

Where a named valley polygon is unavailable, an administrator can associate **reviewed landform records** with a **resolved principal river**. This produces an **Estimated valley floor**, always `partially_resolved`, with a dotted boundary and separately labelled estimated area. It is not a complete ridge-to-ridge valley, a wine region, a catchment, or flood-risk mapping. It stays outside the resolved catalogue, but searching the name displays the saved estimate immediately. The job stops at **Estimate available**, without another automatic AI-review loop. Explicit new research remains available.

The first landform adapter uses [Victoria's GMU250 geomorphology dataset](https://discover.data.vic.gov.au/dataset/geomorphology-of-victoria), licensed CC BY 4.0. Register the **Victorian GMU250 landforms** format and approve its licence and attribution. The endpoint is `https://opendata.maps.vic.gov.au/geoserver/wfs`, layer `open-data-platform:gmu250`. Under a valley's **Feature settings**, select this source, a resolved principal river, reviewed `gmu250.*` record IDs, a geographic evidence URL, and a scope/limitations note. These per-feature associations are data, not hard-coded feature names. Selecting records requires geographic review; the system does not infer a valley merely by replacing "Valley" with "River".

The adapter requests only those IDs in WGS84, checks that every requested record was returned exactly once, and saves the raw response geometry, request URL and checksum. The initial supported classification is GMU `1.3.3` (terraces, fans and floodplains), pattern `TER`, element `TEP`. Other classes require an explicit processor rule, not a change to the source's completeness label. Polygon components must intersect the approved principal river and Victoria. Turf unions the retained polygons, preserves holes, and computes their combined area. No river buffer, rectangular extent, or invented connecting polygon becomes the valley boundary. Limits are 32 reviewed records, 128 retained polygon components, 500,000 input vertices and the existing 20 MB response limit.

The association itself is an interpretation: mapped polygons may extend along tributaries and omit valley sides or gaps. Generalised regional mapping is not suitable for property-level boundaries. Provenance includes the landform records and supporting river evidence. Reprocessing or withdrawing the principal river invalidates the dependent estimate, preserving its audit history; retry with a current resolved river to refresh it. Source changes also invalidate dependent results. No schema migration, extra service or new dependency is required. DEM-based ridge-to-ridge valley derivation remains unimplemented.

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

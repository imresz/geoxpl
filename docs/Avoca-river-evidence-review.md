# Avoca River Evidence Review

Reviewed 2026-09-19. Follow-up to approved research report `495eb027-5210-4299-bf12-3b790108ea3f`, request `b594fe4a-78bb-4e73-a3a3-62aeae1dbaba`.

## Outcome

The available BoM named reach can be traced by published flow direction and downstream links: **102 segments, 316.215514 km**. It remains **partially resolved**, not a verified full source-to-mouth river. No unnamed upstream branch, inferred lake connector, or other river has been appended. No additional AI research call was required.

The selected official `FeatureServer/6` endpoint previously bypassed the directed adapter and received generic geometric candidate processing. It now uses the same directed adapter as the equivalent `MapServer/6`. Feature-level source selection and aliases are unchanged. These implementation rules are documented in the README; this document records this feature's evidence.

## Sources And Identity

The [North Central River Health Strategy](https://www.nccma.vic.gov.au/media/documents/nccma-10926.pdf) places the upper river near Mount Lonarch and distinguishes the Avoca route to Lake Bael Bael from distributaries such as Lalbert and Tyrrell. The [Victorian Fisheries Authority](https://vfa.vic.gov.au/recreational-fishing/fishing-locations/inland-angling-guide/areas/avoca/avoca-angling-waters) also describes Lake Bael Bael as the river's terminal lake. These descriptions support regional identity, not exact segment selection or surveyed endpoints.

The [North Central water discussion paper](https://nccma.vic.gov.au/media/documents/discussion_paper_for_rcs_water.pdf) describes exceptional flood connections beyond the marshes. They do not establish that Murray River, Little Murray River or those distributaries are aliases for Avoca River. No such aliases were added.

Fresh BoM records were compared with the saved Vicmap Hydro, BoM mapped-stream and Geoscience Australia snapshots already attached to this request. Comparison sources supply checks, not additional route geometry. They were not all freshly downloaded, and the GA and BoM mapped records share upstream mapping lineage, so agreement is not necessarily independent corroboration.

## Upstream Gap

The first named BoM segment is **43428631**, starting at node **43213870**, coordinate **143.365555630, -37.274999969**. That node is a junction (type 4), not a headwater (type 9).

Two unnamed streams enter it. Both have known flow direction and downstream ID 43428631:

| Stream HydroID | Upstream node | Upstream coordinate (longitude, latitude) | AUSHYDROID |
| --- | --- | --- | --- |
| 43428377 | 43213612, headwater | 143.343333408, -37.282222191 | 8771666 |
| 43428504 | 43213737, headwater | 143.354444519, -37.294444414 | 8732803 |

Neither stream's AUSHYDROID matches the named Avoca mapping inspected. The most southerly named GA record has AUSHYDRO_ID **8771675** (BoM mapped HydroID **41621211**) and starts near **143.352941502, -37.284568997**. The corresponding upper Vicmap named record, PFI **8711530**, is classified `connector_river` and starts near **143.353448596, -37.284620219**. These are not either of the two BoM headwater coordinates.

This is an identity/representation mismatch, not permission to choose the longer stream, the larger upstream catchment or the closest mapped point. Both alternatives and upstream node records are retained in the checksum-covered import. Neither is route geometry; no source marker is asserted.

## Branch Review And Length

The directed route has seven outgoing branch decisions:

| Junction node | Selected stream | Other outgoing stream | Rule |
| --- | --- | --- | --- |
| 43214300 | 43429062 | 43429063 | Published next-down ID |
| 43214685 | 43429456 | 43429457 | Published next-down ID |
| 43215065 | 43429823 | 43429822 | Requested-name continuity |
| 43215293 | 43430042 | 43430041 | Requested-name continuity |
| 43215605 | 43430347 | 43430346 | Published next-down ID |
| 43216532 | 43431231 | 43431232 | Published next-down ID |
| 43217833 | 43432492 | 43432493 | Published next-down ID |

No preferred-flow table records were supplied for these junctions. Flow direction, node IDs and exact endpoint continuity were checked on the selected route. Named continuity is the application's explicit identity rule, not a claim of a publisher-certified main stem.

The earlier 12-junction count described undirected geometric branching, including joins. It is not a count of outgoing decisions along one directed route. The new trace independently reproduces the earlier geometric candidate's length; equal length alone was not used as evidence.

- All 109 named records: **323.801125 km**.
- Selected 102-record route: **316.215514 km**.
- Seven excluded named records: **7.585611 km**.
- Excluded named HydroIDs: 43429063, 43429457, 43430346, 43430350, 43430351, 43431232, 43432493.

Thus the reported lengths are consistent: the larger number includes alternative named branches. The 316.2 km measure is a BoM modelled path, not a certified conventional river length.

## Downstream Gap

The last selected stream, **43432521**, is an artificial/modelled connector (type 2) with `nextdownid=-1`. Its endpoint matches classified network terminus **43217925**, coordinate **143.735277856, -35.698055512**. This supports the label **BoM network terminus**, not an independently verified physical river mouth.

A fresh spatial query of [BoM waterbody layer 10](https://hosting.wsapi.cloud.bom.gov.au/arcgis/rest/services/ahgf/Geofabric_V3x_All_Products/MapServer/10) places that point inside unnamed swamp HydroID **43625505**, whose `netnodeid` is also 43217925. The point is **outside** the named Lake Bael Bael polygon **43631678**, and outside Little Lake Bael Bael **43630253**. Both named lake records instead reference network node **43218205**. Layer 27 returns the same named lake geometries.

Consequently this trace must not be labelled a verified Lake Bael Bael shoreline entry. No connection from node 43217925 to 43218205 has been invented. Published descriptions establish the destination lake generally, but do not resolve this network-to-waterbody discrepancy.

## Registry And Audit Actions

- The selected BoM source's vague `Public` licence is replaced by the verified **CC BY 4.0** statement from the [BoM download/licence page](https://www.bom.gov.au/water/geofabric/download.shtml). Its completeness remains unknown; approval does not certify an individual feature.
- The Melbourne Water land-search landing page, source `de7eea21-5d80-415e-9cad-ab1a1714fc74`, is rejected for geometry import. Its history is retained. The existing approved numeric waterway layer remains available but has no Avoca matches in the saved comparison snapshot.
- Avoca is reprocessed without another AI report. The existing approved report receives review findings and an audit event; previously resolved features are unchanged.
- Fresh waterbody query responses and the review summary are archived under `runtime/evidence/avoca-20260919/`; river topology, headwater context and derivation provenance are stored in the database.

## Evidence Still Needed

1. A source-backed identification of Avoca's upstream limit and its correspondence to the modelled network. A publisher's crosswalk, reviewed authoritative mapping or documented geographic assessment must explain the conflicting named/modeled headwater representations. It may establish that neither unnamed modelled branch is the correct full named extent.
2. A source-backed explanation or mapping of the terminal wetland connection to Lake Bael Bael, with an explicit endpoint definition. A hydrologic network terminus and a physical lake-entry mouth are different claims.

Simply marking research reviewed, approving source completeness, adding unrelated aliases, or retrying unchanged data cannot supply these facts. The available partial route can be inspected while those questions remain open.

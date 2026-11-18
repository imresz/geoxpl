import { createStore } from '../server/store.js';
import { indexRouteRevision } from '../server/route-memberships.js';

if(!process.argv.includes('--apply')) throw Error('Stop the GeoXpl server, then pass --apply to index retained route evidence.');
const store=createStore(process.env.GEOXPL_DB || 'runtime/geoxpl.sqlite');
try {
  const revisions=store.db.prepare(`SELECT d.id FROM derivations d
    WHERE json_extract(d.data,'$.type')='road_route' AND json_extract(d.data,'$.roadRoute') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM route_membership_revisions r WHERE r.revision_id=d.id) ORDER BY d.rowid`).all();
  let indexed=0;
  for(const {id} of revisions) {
    store.db.exec('BEGIN IMMEDIATE');
    try {indexRouteRevision(store.db,id,'saved_inputs_backfill');store.db.exec('COMMIT');indexed++;}
    catch(error) {store.db.exec('ROLLBACK');throw error;}
    if(indexed%50===0) console.log(`Indexed ${indexed}/${revisions.length} retained route revisions`);
  }
  console.log(`Indexed ${indexed} revisions. Geometry, route status and research settings were not changed. Safe to rerun.`);
} finally {store.close();}

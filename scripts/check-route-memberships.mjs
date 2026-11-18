import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { routeMembershipReport } from '../server/route-memberships.js';

const path=process.env.GEOXPL_DB || 'runtime/geoxpl.sqlite',db=new DatabaseSync(path,{readOnly:true});
const fingerprints=database=>Object.fromEntries([
  ['features','SELECT id,job_id,identity_key,active,data,created FROM features ORDER BY id'],
  ['derivations','SELECT id,feature_id,data,created FROM derivations ORDER BY id']
].map(([name,sql])=>{
  const hash=createHash('sha256');for(const row of database.prepare(sql).iterate())hash.update(JSON.stringify(row)+'\n');
  return [name,hash.digest('hex')];
}));
try {
  const option=process.argv.indexOf('--compare-db');
  if(option>=0) {
    const old=new DatabaseSync(process.argv[option+1],{readOnly:true});
    try {
      if(JSON.stringify(fingerprints(old))!==JSON.stringify(fingerprints(db)))throw Error('Feature or derivation data differs from the pre-backfill backup.');
      console.log('Verified: all feature rows and original geometry derivations are byte-for-byte unchanged.');
    } finally {old.close();}
  }
  console.log(JSON.stringify({revisions:db.prepare('SELECT COUNT(*) n FROM route_membership_revisions').get().n,
    memberships:db.prepare('SELECT COUNT(*) n FROM route_memberships').get().n,
    unlinked:db.prepare("SELECT SUM(json_extract(data,'$.coverage.unlinked')) n FROM route_membership_revisions").get().n}));
  for(const code of ['24','26']) {
    const f=db.prepare('SELECT id FROM features WHERE active=1 AND identity_key=?').get(`vicmap:metro-route:${code}`);
    if(!f)continue;
    const revision=db.prepare('SELECT id FROM derivations WHERE feature_id=? ORDER BY rowid DESC LIMIT 1').get(f.id);
    const report=routeMembershipReport(db,f.id,revision.id);
    console.log(JSON.stringify({route:code,coverage:report.coverage,jobId:db.prepare('SELECT job_id FROM features WHERE id=?').get(f.id).job_id,
      shared:report.shared.groups.map(g=>({route:g.route.name,matched:g.sections.filter(s=>s.geometryMatches).length,
        differentGeometry:g.sections.filter(s=>!s.geometryMatches).length}))}));
  }
} finally {db.close();}

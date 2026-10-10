import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/store.js';
import { queueInvestigation } from '../server/report-workflow.js';

if (process.argv[2]==='queue-avoca') {
  const store=createStore();
  try {
    const job=store.jobs().find(j=>j.normalized==='avoca river'&&!j.superseded_by);
    const report=store.reports().find(r=>r.job_id===job?.id);
    if(!job||!report)throw Error('Avoca request/report not found');
    const action=queueInvestigation(store,report.id,{operation:'gap',targetName:'Lake Bael Bael',radiusKm:10,discover:true});
    console.log(JSON.stringify({reportId:report.id,actionId:action.id,status:action.status}));
  } finally {store.close();}
} else {
  const db=new DatabaseSync('runtime/geoxpl.sqlite',{readOnly:true});
  const actions=db.prepare("SELECT id,status,input,result FROM report_actions WHERE kind='investigate' ORDER BY created DESC LIMIT 5").all().map(r=>({...r,input:JSON.parse(r.input),result:JSON.parse(r.result)})).filter(r=>r.input.operation==='gap');
  console.log(JSON.stringify({activeJobs:db.prepare("SELECT count(*) n FROM jobs WHERE status='pending' AND phase IN ('importing','processing','researching')").get().n,activeActions:db.prepare("SELECT count(*) n FROM report_actions WHERE status='running'").get().n,
    actions:actions.map(a=>({id:a.id,status:a.status,message:a.result.message,checks:a.result.checks?.map(c=>({name:c.source.name,status:c.status,total:c.total,message:c.message})),targets:a.result.targets,routes:a.result.routes,candidateIds:a.result.candidateIds,research:a.result.research?.provider}))}));
  db.close();
}

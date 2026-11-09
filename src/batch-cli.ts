/** Local native CLI: one signed approval runs the whole bounded sequence. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {runApprovedBatch} from './batch-live.js';
import {JsonBatchStateStore,type BatchPlan} from './batch-coordinator.js';
import {PROJECTS,projectConfig,type ProjectKey} from './config.js';

function validProject(v:string):v is ProjectKey {
 return Object.hasOwn(PROJECTS,v);
}
async function main(){
 const [verb,arg1,arg2]=process.argv.slice(2);
 if(verb==='run'){
  if(!arg1||arg2)throw Error('Usage: npm run batch:run -- <absolute-batch-plan.json>');
  if(!path.isAbsolute(arg1))throw Error('BATCH_PLAN_PATH_MUST_BE_ABSOLUTE');
  const p=JSON.parse(await readFile(arg1,'utf8')) as BatchPlan;
  if(!p||typeof p.batchId!=='string'||!validProject(p.project))
   throw Error('INVALID_BATCH_PLAN');
  const s=await runApprovedBatch(p);
  process.stdout.write(JSON.stringify({batchId:s.batchId,phase:s.phase,
   accepted:s.accepted.map(x=>x.trancheId),trancheIndex:s.trancheIndex,
   executions:s.executionCount,reason:s.reason??null},null,2)+'\n');
  if(s.phase!=='COMPLETE')process.exitCode=2;
  return;
 }
 if(verb==='status'){
  if(!arg1||!arg2||!validProject(arg1)|| !/^[A-Za-z0-9._-]{3,120}$/.test(arg2))
   throw Error('Usage: npm run batch:status -- <prysm|gacm|sandbox> <batch-id>');
  const folder=path.join(projectConfig(arg1).proofRoot,'BATCH-'+arg2,'state');
  const s=await new JsonBatchStateStore(folder).load(arg2);
  process.stdout.write(JSON.stringify(s??{batchId:arg2,state:'NOT_FOUND'},null,2)+'\n');
  return;
 }
 throw Error('Usage: npm run batch:run -- <absolute-plan.json>, or npm run batch:status -- <project> <batch-id>');
}
main().catch(error=>{process.stderr.write('GACM_BATCH_HOLD: '+(error instanceof Error?error.message:String(error))+'\n');
 process.exitCode=2;});

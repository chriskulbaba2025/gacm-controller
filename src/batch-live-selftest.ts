/** Actual live-adapter sandbox integration with simulated, zero-provider Codex. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
async function command(cwd:string,exe:string,args:string[]){
 return new Promise<string>((resolve,reject)=>{
  const child=spawn(exe,args,{cwd,shell:false,windowsHide:true});
  let out='',err='';
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  child.on('error',reject);
  child.on('close',c=>c===0?resolve(out.trim()):reject(Error(exe+' '+args.join(' ')+' '+err)));
 });
}
test('real adapter runs signed 3-tranche local Git batch, failed audit then repair then advance',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'gacm-live-'));
 const bare=path.join(root,'bare.git'),source=path.join(root,'source'),proof=path.join(root,'proof'),
  execRoot=path.join(root,'worktrees'),approvalDir=path.join(root,'approvals'),checks=path.join(root,'checks'),
  recipes=path.join(root,'recipes');
 for(const p of [source,proof,execRoot,approvalDir,checks,recipes])await mkdir(p,{recursive:true});
 await command(root,'git',['init','--bare',bare]);
 await command(source,'git',['init','-b','approved']);
 await command(source,'git',['config','user.email','gacm-fixture@example.invalid']);
 await command(source,'git',['config','user.name','GACM Sandbox']);
 await mkdir(path.join(source,'src'),{recursive:true});
 await writeFile(path.join(source,'checker.mjs'),
  "import fs from 'node:fs';import path from 'node:path';"+
  "const file=path.join(process.cwd(),'src',process.argv[2]+'.txt');"+
  "process.exit(fs.existsSync(file)&&fs.readFileSync(file,'utf8')==='PASS'?0:1);");
 await command(source,'git',['add','.']);await command(source,'git',['commit','-m','base']);
 await command(source,'git',['remote','add','origin',bare]);
 await command(source,'git',['push','-u','origin','approved']);
 const startSha=await command(source,'git',['rev-parse','HEAD']);
 const fake=path.join(root,'fake-codex.cjs');
 await writeFile(fake,"const fs=require('node:fs'),path=require('node:path');"+
 "const a=process.argv.slice(2);"+
 "if(a[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}"+
 "if(a[0]!=='exec')process.exit(2);"+
 "const dir=a[a.indexOf('-C')+1],final=a[a.indexOf('--output-last-message')+1];"+
 "const prompt=a[a.length-1],m=prompt.match(/tranche (T[1-3]) attempt (\\d+)/);"+
 "if(!m)process.exit(3);"+
 "fs.mkdirSync(path.join(dir,'src'),{recursive:true});"+
 "fs.writeFileSync(path.join(dir,'src',m[1]+'.txt'),m[1]==='T1'&&m[2]==='1'?'FAIL':'PASS');"+
 "fs.writeFileSync(final,'RESULT:\\nPASS\\nBLOCKER:\\nNone\\nNEXT ACTION:\\nIndependent audit.');"+
 "console.log('SIMULATED CODEX, NO PROVIDER CALL');");
 process.env.PRYSM_GACM_CODEX_CLI_JS=fake;
 process.env.GACM_BATCH_APPROVAL_DIR=approvalDir;
 process.env.GACM_BATCH_CONTRACT_DIR=checks;
 process.env.GACM_BATCH_RECIPE_DIR=recipes;
 const {PROJECTS}=await import('./config.js');
 PROJECTS.sandbox.root=source;PROJECTS.sandbox.expectedRemote=bare;
 PROJECTS.sandbox.proofRoot=proof;PROJECTS.sandbox.executionRoot=execRoot;
 PROJECTS.gacm.proofRoot=proof;
 const {canonical,frozenDigest}=await import('./batch-coordinator.js');
 const {recipeDigest}=await import('./batch-action-gate.js');
 const {runApprovedBatch}=await import('./batch-live.js');
 const tranches=[];
 for(let i=1;i<=3;i++){
  const id='T'+i;
  const contract={schema:'GACM_BATCH_VERIFIER_V1',checks:[{
    id:'check-'+id,executable:'node',args:['checker.mjs',id],timeoutSeconds:15}]};
  const verificationContractDigest=sha(canonical(contract));
  await writeFile(path.join(checks,id+'.json'),JSON.stringify(contract));
  const mkRule=(kind:string,tool:string,keys:string[],exact:Record<string,string>,values?:Record<string,number[]>)=>({
    action_kind:kind,tools:[tool],target_patterns:[bare],
    parameter_constraints:{allowed_keys:keys,required_keys:keys,exact,allowed_values:values||{}},
    judgment_slot_id:null});
  const recipe={schema:'GACM_EXECUTION_RECIPE_V1',recipe_id:'recipe-'+id,version:'1',
   state:'FROZEN',work_unit_id:id,mutation_policy:'GOVERNED_REFREEZE_REQUIRED',steps:[
    {step_id:'execute',sequence:1,allowed_actions:[mkRule('CODEX_EXECUTE','codex-cli',
      ['tranche','model','effort','attempt'],{tranche:id,model:'gpt-5.6-luna',effort:'medium'},{attempt:[1,2,3]})],
      bounded_judgment_slots:[],acceptable_prior_states:['EXECUTION'],
      expected_result_states:['EXECUTED'],evidence_requirements:['codex-log'],stop_conditions:['auth-drift']},
    {step_id:'verify',sequence:2,allowed_actions:[mkRule('INDEPENDENT_VERIFY','gacm-local-verifier',
      ['tranche','contractDigest','candidateDigest'],{tranche:id,contractDigest:verificationContractDigest})],
      bounded_judgment_slots:[],acceptable_prior_states:['EXECUTION'],
      expected_result_states:['VERIFIED'],evidence_requirements:['verification-log'],stop_conditions:['auth-drift']}
   ]};
  await writeFile(path.join(recipes,id+'.json'),JSON.stringify(recipe));
  tranches.push({id,objective:'Safely implement '+id,verificationContractDigest,executionRecipeDigest:recipeDigest(recipe),
    allowedPaths:['src/**'],forbiddenPaths:['.env'],maxAttempts:3});
 }
 const plan={schema:'GACM_PREAPPROVED_SEQUENTIAL_BATCH_V1',batchId:'signed-fixture-001',project:'sandbox',
  repository:bare,startSha,approvedBranch:'approved',model:'gpt-5.6-luna',reasoningEffort:'medium',
  maxExecutions:6,maxDurationSeconds:120,maxProviderSpendUsd:0,
  permitsProductionMutation:false,permitsPushMergeDeployPublish:false,permitsSubagents:false,
  tranches,approval:{approverId:'operator',authorityRecord:'batch-approval-fixture',frozenDigest:''}};
 plan.approval.frozenDigest=frozenDigest(plan as any);
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 process.env.GACM_BATCH_APPROVER_PUBLIC_KEY=publicKey.export({type:'spki',format:'pem'}).toString();
 const record={schema:'GACM_SIGNED_BATCH_APPROVAL_V1',status:'APPROVED',
  batchId:plan.batchId,authorityId:plan.approval.authorityRecord,
  approverId:plan.approval.approverId,frozenDigest:plan.approval.frozenDigest,expiresAt:'2099-01-01T00:00:00Z'};
 const signature=sign(null,Buffer.from(canonical(record)),privateKey).toString('base64');
 await writeFile(path.join(approvalDir,plan.approval.authorityRecord+'.json'),JSON.stringify({...record,signature}));
 const state=await runApprovedBatch(plan as any);
 assert.equal(state.phase,'COMPLETE',state.reason);
 assert.equal(state.executionCount,4);
 assert.deepEqual(state.accepted.map(x=>x.trancheId),['T1','T2','T3']);
 assert.equal(state.attempts.T1,2);
 assert.equal(new Set(state.accepted.map(x=>x.workspaceId)).size,1);
 const worktree=state.accepted[0].workspaceId;
 for(let i=1;i<=3;i++)assert.equal(await readFile(path.join(worktree,'src','T'+i+'.txt'),'utf8'),'PASS');
 assert.equal(await command(source,'git',['rev-parse','HEAD']),startSha);
});

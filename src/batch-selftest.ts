/** No paid models or provider calls: fail-closed coordinator regression. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {generateKeyPairSync,sign} from 'node:crypto';
import {BatchCoordinator,JsonBatchStateStore,canonical,frozenDigest,type BatchPlan,
 type BatchAdapters,type Candidate,type BatchState} from './batch-coordinator.js';
import {verifyBatchApproval} from './batch-live.js';
function plan(n=3):BatchPlan {
 const p:BatchPlan={schema:'GACM_PREAPPROVED_SEQUENTIAL_BATCH_V1',batchId:'unit-batch',
  project:'gacm',repository:'https://github.com/owner/repo.git',
  startSha:'a'.repeat(40),approvedBranch:'candidate',
  model:'gpt-5.6-luna',reasoningEffort:'medium',maxExecutions:8,maxDurationSeconds:600,maxProviderSpendUsd:0,
  permitsProductionMutation:false,permitsPushMergeDeployPublish:false,permitsSubagents:false,
  tranches:Array.from({length:n},(_,i)=>({id:'T'+(i+1),objective:'Tranche '+(i+1),
   verificationContractDigest:String(i+1).repeat(64),allowedPaths:['src/**'],forbiddenPaths:['.env'],
   maxAttempts:3})),approval:{approverId:'owner',authorityRecord:'human-approval-1',frozenDigest:''}};
 p.approval.frozenDigest=frozenDigest(p);return p;
}
function candidate(n:number):Candidate{
 return {workspaceId:'same-worktree',sourceSha:'a'.repeat(40),changeDigest:String(n).padStart(64,'0'),
  changedPaths:['src/core.ts']};
}
function adapters(over:Partial<BatchAdapters>={},events:string[]=[]):BatchAdapters{
 let n=0;
 return {verifyApproval:async(p,d)=>({status:'PASS',authorityId:p.approval.authorityRecord,digest:d}),
  preflight:async()=>{events.push('preflight');},
  execute:async(p,t,a,op,previous)=>{events.push(t.id+':'+a+':'+(previous?.workspaceId||'NEW'));
   return {runId:'run-'+(++n),candidate:candidate(n),model:p.model,effort:p.reasoningEffort,status:'EXECUTED'};},
  verifyCandidateScope:async()=>{events.push('scope');},
  verify:async(p,t,r)=>({status:'PASS',issuerRole:'INDEPENDENT_VERIFIER',runId:r.runId,
    changeDigest:r.candidate.changeDigest,contractDigest:t.verificationContractDigest,evidenceRefs:['proof']}),
  revalidateAccepted:async(p,s,c)=>({status:'PASS',issuerRole:'INDEPENDENT_VERIFIER',
    candidateChangeDigest:c.changeDigest,acceptedTrancheIds:s.accepted.map(x=>x.trancheId),
    evidenceRefs:['recheck']}),...over};
}
async function runner(over:Partial<BatchAdapters>={},events:string[]=[]){
 const store=new JsonBatchStateStore(await mkdtemp(path.join(os.tmpdir(),'gacm-batch-')));
 return {run:new BatchCoordinator(adapters(over,events),store),store};
}
test('three tranches, same worktree, proof and advancement',async()=>{
 const events:string[]=[],r=await runner({},events),s=await r.run.run(plan());
 assert.equal(s.phase,'COMPLETE');assert.equal(s.executionCount,3);
 assert.deepEqual(s.accepted.map(x=>x.trancheId),['T1','T2','T3']);
 assert.deepEqual(events.filter(x=>x.startsWith('T')),['T1:1:NEW','T2:1:same-worktree','T3:1:same-worktree']);
});
test('failed independent audit repairs before continuing',async()=>{
 let i=0;const events:string[]=[],r=await runner({verify:async(p,t,x)=>({status:++i===1?'FAIL':'PASS',
 issuerRole:'INDEPENDENT_VERIFIER',runId:x.runId,changeDigest:x.candidate.changeDigest,
 contractDigest:t.verificationContractDigest,evidenceRefs:['independent'],defectFamily:'TYPECHECK'})},events);
 const s=await r.run.run(plan(2));assert.equal(s.phase,'COMPLETE');assert.equal(s.executionCount,3);
 assert.deepEqual(events.filter(x=>x.startsWith('T')),['T1:1:NEW','T1:2:same-worktree','T2:1:same-worktree']);
});
test('executor PASS cannot replace independent verification',async()=>{
 const r=await runner({verify:async(p,t,x)=>({status:'PASS',issuerRole:'EXECUTOR',runId:x.runId,
 changeDigest:x.candidate.changeDigest,contractDigest:t.verificationContractDigest,evidenceRefs:['invented']})});
 const s=await r.run.run(plan());assert.equal(s.phase,'HOLD');assert.equal(s.trancheIndex,0);
});
test('accepted tranche currentness is verified on new candidate',async()=>{
 const r=await runner({revalidateAccepted:async(p,s,c)=>({status:'FAIL',
  issuerRole:'INDEPENDENT_VERIFIER',candidateChangeDigest:c.changeDigest,
  acceptedTrancheIds:s.accepted.map(x=>x.trancheId),evidenceRefs:['regressed']})});
 const s=await r.run.run(plan());assert.equal(s.phase,'HOLD');assert.equal(s.trancheIndex,1);
});
test('unapproved model rejected prior to any dispatch',async()=>{
 const p=plan();(p as any).model='gpt-5.6';p.approval.frozenDigest=frozenDigest(p);
 const r=await runner();await assert.rejects(r.run.run(p),/MODEL/);
});
test('interrupted in-flight action is not replayed',async()=>{
 const p=plan(),r=await runner();
 const state:BatchState={schema:'GACM_SEQUENTIAL_BATCH_STATE_V1',batchId:p.batchId,
 frozenDigest:frozenDigest(p),phase:'EXECUTING',trancheIndex:0,attempts:{T1:1},
 familyAttempts:{},executionCount:1,startedAt:new Date().toISOString(),
 inFlight:{trancheId:'T1',operationId:'already-dispatched'},accepted:[],lastCandidate:null};
 await r.store.save(state);const s=await r.run.run(p);
 assert.equal(s.phase,'HOLD');assert.equal(s.executionCount,1);
});
test('missing signature cannot approve and valid Ed25519 signature can',async()=>{
 const p=plan(),root=await mkdtemp(path.join(os.tmpdir(),'gacm-sign-'));
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 process.env.GACM_BATCH_APPROVAL_DIR=root;
 process.env.GACM_BATCH_APPROVER_PUBLIC_KEY=publicKey.export({type:'spki',format:'pem'}).toString();
 const digest=frozenDigest(p);
 assert.equal((await verifyBatchApproval(p,digest)).status,'HOLD');
 const record={schema:'GACM_SIGNED_BATCH_APPROVAL_V1',status:'APPROVED',batchId:p.batchId,
  authorityId:p.approval.authorityRecord,approverId:p.approval.approverId,frozenDigest:digest,
  expiresAt:'2099-01-01T00:00:00Z'};
 const signature=sign(null,Buffer.from(canonical(record)),privateKey).toString('base64');
 await writeFile(path.join(root,p.approval.authorityRecord+'.json'),JSON.stringify({...record,signature}));
 assert.equal((await verifyBatchApproval(p,digest)).status,'PASS');
 const bad={...record,status:'REVOKED',signature};
 await writeFile(path.join(root,p.approval.authorityRecord+'.json'),JSON.stringify(bad));
 assert.equal((await verifyBatchApproval(p,digest)).status,'HOLD');
 delete process.env.GACM_BATCH_APPROVAL_DIR;delete process.env.GACM_BATCH_APPROVER_PUBLIC_KEY;
});

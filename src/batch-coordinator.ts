/**
 * GACM pre-approved sequential batch coordinator.
 * The existing controller supplies authenticated approval, same-worktree
 * execution, independent verification and deterministic scope checks.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type BatchOutcome = 'PASS' | 'FAIL' | 'HOLD';
export type Phase = 'PENDING' | 'EXECUTING' | 'VERIFYING' | 'REPAIRING' | 'COMPLETE' | 'FAIL' | 'HOLD';
export type ApprovalResult = { status: BatchOutcome; authorityId: string; digest: string };
export type Candidate = { workspaceId: string; sourceSha: string; changeDigest: string; changedPaths: string[] };
export type ExecutionReceipt = { runId: string; candidate: Candidate; model: string; effort: string; status: 'EXECUTED' | 'BLOCKED'; failureReason?: string };
export type VerificationReceipt = { status: BatchOutcome; issuerRole: string; runId: string; changeDigest: string; contractDigest: string; evidenceRefs: string[]; defectFamily?: string; reason?: string };
export type FrozenTranche = {
  id: string; objective: string; verificationContractDigest: string;
  allowedPaths: string[]; forbiddenPaths: string[]; maxAttempts: number;
};
export type BatchPlan = {
  schema: 'GACM_PREAPPROVED_SEQUENTIAL_BATCH_V1';
  batchId: string; project: string; repository: string; startSha: string; approvedBranch: string;
  model: 'gpt-5.6-luna'; reasoningEffort: 'medium';
  maxExecutions: number; maxDurationSeconds: number; maxProviderSpendUsd: 0;
  permitsProductionMutation: false; permitsPushMergeDeployPublish: false; permitsSubagents: false;
  tranches: FrozenTranche[];
  approval: {approverId: string;authorityRecord: string;frozenDigest: string};
};
export type BatchState = {
  schema: 'GACM_SEQUENTIAL_BATCH_STATE_V1'; batchId: string; frozenDigest: string;
  phase: Phase; trancheIndex: number; attempts: Record<string,number>;
  familyAttempts: Record<string,number>; executionCount: number; startedAt: string;
  inFlight: {trancheId:string;operationId:string;runId?:string}|null;
  accepted: Array<{trancheId:string;runId:string;workspaceId:string;changeDigest:string;evidenceRefs:string[]}>;
  lastCandidate: Candidate|null; reason?: string;
};
export interface BatchAdapters {
  verifyApproval(plan:BatchPlan,digest:string):Promise<ApprovalResult>;
  preflight(plan:BatchPlan,state:BatchState):Promise<void>;
  execute(plan:BatchPlan,tranche:FrozenTranche,attempt:number,operationId:string,prior:Candidate|null):Promise<ExecutionReceipt>;
  verify(plan:BatchPlan,tranche:FrozenTranche,receipt:ExecutionReceipt):Promise<VerificationReceipt>;
  verifyCandidateScope(plan:BatchPlan,tranche:FrozenTranche,receipt:ExecutionReceipt):Promise<void>;
  revalidateAccepted(plan:BatchPlan,state:BatchState,candidate:Candidate):Promise<{
    status:BatchOutcome;issuerRole:string;candidateChangeDigest:string;acceptedTrancheIds:string[];evidenceRefs:string[];
  }>;
}
export function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value !== null && typeof value === 'object')return '{'+Object.entries(value as Record<string,unknown>)
    .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export function frozenDigest(plan:BatchPlan):string {
  const {approval:_approval,...frozen}=plan;
  return createHash('sha256').update(canonical(frozen)).digest('hex');
}
function assertPlan(plan:BatchPlan):void {
  if(plan.schema!=='GACM_PREAPPROVED_SEQUENTIAL_BATCH_V1'|| !/^[A-Za-z0-9._-]{3,120}$/.test(plan.batchId))
    throw Error('INVALID_BATCH_ID');
  if(!plan.project||!plan.repository||!plan.approvedBranch|| !/^[a-f0-9]{40}$/.test(plan.startSha))
    throw Error('MISSING_FROZEN_REPOSITORY_IDENTITY');
  if(plan.model!=='gpt-5.6-luna'||plan.reasoningEffort!=='medium')throw Error('UNAUTHORIZED_MODEL_OR_EFFORT');
  if(plan.maxProviderSpendUsd!==0||plan.permitsProductionMutation!==false||
      plan.permitsPushMergeDeployPublish!==false||plan.permitsSubagents!==false)
    throw Error('UNAUTHORIZED_SIDE_EFFECT_OR_COST');
  if(!Number.isSafeInteger(plan.maxExecutions)||plan.maxExecutions<1||plan.maxExecutions>100||
      !Number.isSafeInteger(plan.maxDurationSeconds)||plan.maxDurationSeconds<1)throw Error('INVALID_BATCH_BOUNDS');
  if(!Array.isArray(plan.tranches)||plan.tranches.length<2||plan.tranches.length>plan.maxExecutions)
    throw Error('INVALID_BATCH_LENGTH');
  if(!plan.approval||!plan.approval.authorityRecord||!plan.approval.approverId||
      plan.approval.frozenDigest!==frozenDigest(plan))throw Error('INVALID_FROZEN_APPROVAL_DIGEST');
  const ids=new Set<string>();
  for(const t of plan.tranches){
    if(!t.id||ids.has(t.id)||!t.objective|| !/^[a-f0-9]{64}$/.test(t.verificationContractDigest))
      throw Error('INVALID_TRANCHE');
    ids.add(t.id);
    if(!Number.isSafeInteger(t.maxAttempts)||t.maxAttempts<1||t.maxAttempts>3)throw Error('INVALID_RETRY_BOUND');
    if(!Array.isArray(t.allowedPaths)||!t.allowedPaths.length||!Array.isArray(t.forbiddenPaths))
      throw Error('INVALID_SCOPE');
    if([...t.allowedPaths,...t.forbiddenPaths].some(x=>!x||x.startsWith('/')||x.includes('..')||
        x.includes('\\')||x.startsWith('.git')))throw Error('UNSAFE_PATH_PATTERN');
  }
}
export class JsonBatchStateStore {
  constructor(private readonly directory:string){}
  private filename(batchId:string){return path.join(this.directory,batchId+'.json');}
  async load(batchId:string):Promise<BatchState|null>{
    try{return JSON.parse(await readFile(this.filename(batchId),'utf8')) as BatchState;}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
  }
  async save(state:BatchState):Promise<void>{
    await mkdir(this.directory,{recursive:true});
    const target=this.filename(state.batchId);
    const tmp=target+'.tmp-'+process.pid+'-'+createHash('sha256').update(state.inFlight?.operationId||state.phase).digest('hex').slice(0,10);
    await writeFile(tmp,canonical(state)+'\n',{encoding:'utf8',flag:'wx'});
    await rename(tmp,target);
  }
  async withLock<T>(batchId:string,fn:()=>Promise<T>):Promise<T>{
    await mkdir(this.directory,{recursive:true});
    const name=this.filename(batchId)+'.lock';
    const handle=await open(name,'wx');
    try{return await fn();} finally {await handle.close();await rm(name);}
  }
}
export class BatchCoordinator {
  constructor(private readonly adapters:BatchAdapters,private readonly store:JsonBatchStateStore,
    private readonly now:()=>Date=()=>new Date()){}
  async run(plan:BatchPlan):Promise<BatchState>{
    assertPlan(plan);
    return this.store.withLock(plan.batchId,()=>this.runLocked(plan));
  }
  private async runLocked(plan:BatchPlan):Promise<BatchState>{
    const digest=frozenDigest(plan);
    const prior=await this.store.load(plan.batchId);
    let s:BatchState=prior??{schema:'GACM_SEQUENTIAL_BATCH_STATE_V1',batchId:plan.batchId,frozenDigest:digest,
      phase:'PENDING',trancheIndex:0,attempts:{},familyAttempts:{},executionCount:0,startedAt:this.now().toISOString(),
      inFlight:null,accepted:[],lastCandidate:null};
    if(s.schema!=='GACM_SEQUENTIAL_BATCH_STATE_V1'||s.batchId!==plan.batchId||s.frozenDigest!==digest)
      throw Error('BATCH_IDENTITY_OR_CONTRACT_DRIFT');
    const stop=async(reason:string,phase:'HOLD'|'FAIL'='HOLD')=>{
      s.phase=phase;s.reason=reason;await this.store.save(s);return s;
    };
    if(s.phase==='COMPLETE'||s.phase==='HOLD'||s.phase==='FAIL')return s;
    if(s.inFlight)return stop('INTERRUPTED_ACTION_REQUIRES_EXACT_EFFECT_RECONCILIATION');
    try{
      const approval=await this.adapters.verifyApproval(plan,digest);
      if(approval.status!=='PASS'||approval.digest!==digest||approval.authorityId!==plan.approval.authorityRecord)
        return stop('APPROVAL_MISSING_STALE_OR_UNTRUSTED');
      while(s.trancheIndex<plan.tranches.length){
        if(this.now().getTime()-Date.parse(s.startedAt)>plan.maxDurationSeconds*1000)return stop('BATCH_DURATION_LIMIT');
        if(s.executionCount>=plan.maxExecutions)return stop('BATCH_EXECUTION_BUDGET_EXHAUSTED');
        const tranche=plan.tranches[s.trancheIndex];
        const attempt=(s.attempts[tranche.id]||0)+1;
        if(attempt>tranche.maxAttempts)return stop('TRANCHE_REPAIR_BOUND_EXHAUSTED');
        const checked=await this.adapters.verifyApproval(plan,digest);
        if(checked.status!=='PASS'||checked.digest!==digest||checked.authorityId!==plan.approval.authorityRecord)
          return stop('APPROVAL_REVOKED_OR_DRIFT');
        await this.adapters.preflight(plan,s);
        s.phase=attempt===1?'EXECUTING':'REPAIRING';
        const opId=createHash('sha256').update(digest+':'+tranche.id+':'+attempt).digest('hex');
        s.inFlight={trancheId:tranche.id,operationId:opId};
        s.attempts[tranche.id]=attempt;s.executionCount++;
        await this.store.save(s);
        const receipt=await this.adapters.execute(plan,tranche,attempt,opId,s.lastCandidate);
        s.inFlight.runId=receipt.runId;await this.store.save(s);
        if(receipt.model!==plan.model||receipt.effort!==plan.reasoningEffort)return stop('EXECUTOR_MODEL_DRIFT');
        if(receipt.candidate.sourceSha!==plan.startSha||!receipt.candidate.workspaceId||
           !/^[a-f0-9]{64}$/.test(receipt.candidate.changeDigest)||
           (s.lastCandidate&&s.lastCandidate.workspaceId!==receipt.candidate.workspaceId))
          return stop('WORKSPACE_OR_CANDIDATE_IDENTITY_DRIFT');
        if(receipt.status!=='EXECUTED')return stop('EXECUTOR_BLOCKED:'+(receipt.failureReason||'UNKNOWN'));
        await this.adapters.verifyCandidateScope(plan,tranche,receipt);
        s.phase='VERIFYING';await this.store.save(s);
        const result=await this.adapters.verify(plan,tranche,receipt);
        if(result.runId!==receipt.runId||result.changeDigest!==receipt.candidate.changeDigest||
           result.contractDigest!==tranche.verificationContractDigest||
           result.issuerRole!=='INDEPENDENT_VERIFIER'||!result.evidenceRefs?.length)
          return stop('INVALID_OR_SELF_ISSUED_VERIFICATION');
        s.lastCandidate=receipt.candidate;s.inFlight=null;
        if(result.status==='PASS'){
          if(s.accepted.length){
            const cont=await this.adapters.revalidateAccepted(plan,s,receipt.candidate);
            if(cont.status!=='PASS'||cont.issuerRole!=='INDEPENDENT_VERIFIER'||
               cont.candidateChangeDigest!==receipt.candidate.changeDigest||!cont.evidenceRefs?.length||
               canonical(cont.acceptedTrancheIds)!==canonical(s.accepted.map(x=>x.trancheId)))
              return stop('ACCEPTED_TRANCHE_CURRENTNESS_FAILED');
          }
          s.accepted.push({trancheId:tranche.id,runId:receipt.runId,workspaceId:receipt.candidate.workspaceId,
            changeDigest:receipt.candidate.changeDigest,evidenceRefs:result.evidenceRefs});
          s.trancheIndex++;s.phase=s.trancheIndex===plan.tranches.length?'COMPLETE':'PENDING';
          await this.store.save(s);continue;
        }
        if(result.status==='HOLD')return stop(result.reason||'INDEPENDENT_VERIFICATION_HOLD');
        if(result.status!=='FAIL')return stop('UNKNOWN_VERIFICATION_RESULT');
        const family=result.defectFamily||'UNCLASSIFIED_VERIFICATION_FAILURE';
        s.familyAttempts[family]=(s.familyAttempts[family]||0)+1;
        await this.store.save(s);
        if(s.familyAttempts[family]>=3)return stop('THREE_FAILED_REPAIRS_RESET_DIAGNOSIS_REQUIRED');
        if(attempt>=tranche.maxAttempts)return stop('TRANCHE_REPAIR_BOUND_EXHAUSTED');
      }
      return s;
    }catch(e){return stop('BLOCKED:'+(e instanceof Error?e.message:String(e)));}
  }
}

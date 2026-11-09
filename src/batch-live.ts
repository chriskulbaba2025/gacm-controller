/** GACM opt-in live adapters. Requires signed human approval, verified subscription and exact test contracts. */
import {createHash,createPublicKey,verify as verifySig} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,lstat,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {BatchCoordinator,JsonBatchStateStore,canonical,type BatchAdapters,type BatchPlan,type BatchState,
  type Candidate,type FrozenTranche,type ExecutionReceipt,type VerificationReceipt} from './batch-coordinator.js';
import {acquireExecutionLock} from './execution-lock.js';
import {ActionGate,recipeDigest,validateRecipe,type Recipe} from './batch-action-gate.js';
import {CODEX_CLI_JS,PROJECTS,projectConfig,type ProjectKey} from './config.js';
import {reconcileExecutionWorkspace,type WorkspaceBinding} from './workspace-bootstrap.js';
const sha=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const safeId=/^[A-Za-z0-9._-]{3,120}$/;
const sameRemote=(a:string,b:string)=>a.trim().replace(/\.git$/i,'').toLowerCase()===b.trim().replace(/\.git$/i,'').toLowerCase();
function eq(a:unknown,b:unknown){return canonical(a)===canonical(b);}
async function cmd(exe:string,args:string[],cwd:string,timeoutMs=120000){
 return new Promise<{code:number;stdout:string;stderr:string}>((resolve,reject)=>{
  const child=spawn(exe,args,{cwd,shell:false,windowsHide:true,env:{...process.env,GIT_TERMINAL_PROMPT:'0',npm_config_offline:'true'}});
  const out:Buffer[]=[],err:Buffer[]=[];
  const timer=setTimeout(()=>child.kill(),timeoutMs);
  child.stdout?.on('data',(b:Buffer)=>out.push(b));child.stderr?.on('data',(b:Buffer)=>err.push(b));
  child.once('error',e=>{clearTimeout(timer);reject(e);});
  child.once('close',n=>{clearTimeout(timer);resolve({code:n??-1,stdout:Buffer.concat(out).toString('utf8'),
    stderr:Buffer.concat(err).toString('utf8')});});
 });
}
async function git(cwd:string,...args:string[]){
 const r=await cmd('git',['-C',cwd,...args],cwd,30000);
 if(r.code!==0)throw Error('GIT_CHECK_FAILED:'+r.stderr.slice(0,200));
 return r.stdout.trim();
}
export async function verifyBatchApproval(p:BatchPlan,digest:string){
 const dir=process.env.GACM_BATCH_APPROVAL_DIR,key=process.env.GACM_BATCH_APPROVER_PUBLIC_KEY;
 if(!dir||!key||!safeId.test(p.approval.authorityRecord))return {status:'HOLD' as const,authorityId:'',digest:''};
 try{
  const r=JSON.parse(await readFile(path.join(dir,p.approval.authorityRecord+'.json'),'utf8'));
  if(r.schema!=='GACM_SIGNED_BATCH_APPROVAL_V1'||r.status!=='APPROVED'||r.batchId!==p.batchId||
    r.authorityId!==p.approval.authorityRecord||r.approverId!==p.approval.approverId||
    r.frozenDigest!==digest||typeof r.expiresAt!=='string'||Date.parse(r.expiresAt)<=Date.now()||
    typeof r.signature!=='string')return {status:'HOLD' as const,authorityId:'',digest:''};
  const {signature,...signed}=r;
  if(!verifySig(null,Buffer.from(canonical(signed)),createPublicKey(key),Buffer.from(signature,'base64')))
    return {status:'HOLD' as const,authorityId:'',digest:''};
  return {status:'PASS' as const,authorityId:r.authorityId as string,digest};
 }catch{return {status:'HOLD' as const,authorityId:'',digest:''};}
}
type Check={id:string;executable:'npm'|'node'|'python';args:string[];timeoutSeconds:number};
type CheckContract={schema:'GACM_BATCH_VERIFIER_V1';checks:Check[]};
function checkContract(c:CheckContract){
 if(c.schema!=='GACM_BATCH_VERIFIER_V1'||!Array.isArray(c.checks)||!c.checks.length)throw Error('INVALID_CHECK_CONTRACT');
 for(const x of c.checks)if(!safeId.test(x.id)||!['npm','node','python'].includes(x.executable)||
    !Array.isArray(x.args)||!x.args.length||x.args.some(a=>typeof a!=='string'||!a||a.length>200||/[\r\n]/.test(a))||
    !Number.isSafeInteger(x.timeoutSeconds)||x.timeoutSeconds<1||x.timeoutSeconds>600)throw Error('UNSAFE_CHECK');
}
function pathMatch(pattern:string,name:string):boolean{
 const p=pattern.split('/').map(part=>part==='**'?'.*':part.replace(/[.*+?^{}()|[\]\\]/g,'\\$&').replace(/\\\*/g,'[^/]*'));
 return new RegExp('^'+p.join('/')+'$').test(name);
}
async function snapshot(root:string,startSha:string){
 if(await git(root,'rev-parse','HEAD')!==startSha)throw Error('HEAD_DRIFT');
 const d=await cmd('git',['-C',root,'diff','--no-ext-diff','--name-only','-z',startSha,'--'],root);
 const u=await cmd('git',['-C',root,'ls-files','--others','--exclude-standard','-z','--'],root);
 if(d.code||u.code)throw Error('CHANGED_SURFACE_UNAVAILABLE');
 const names=[...new Set([...d.stdout.split('\0'),...u.stdout.split('\0')].filter(Boolean))].sort();
 const hashes:Record<string,string>={};
 for(const n of names){
  if(n.startsWith('/')||n.includes('..')||n.includes('\\')||n==='.git'||n.startsWith('.git/'))throw Error('UNSAFE_PATH');
  const absolute=path.resolve(root,n);
  if(!absolute.startsWith(path.resolve(root)+path.sep))throw Error('PATH_ESCAPED');
  try{
   const stat=await lstat(absolute);if(stat.isSymbolicLink()||!stat.isFile())throw Error('UNSAFE_FILE_TYPE:'+n);
   hashes[n]=sha(Buffer.concat([Buffer.from(String(stat.mode)),await readFile(absolute)]));
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')hashes[n]='DELETED';else throw e;}
 }
 return {names,hashes,digest:sha(canonical(hashes))};
}
class LiveAdapters implements BatchAdapters{
 private binding:WorkspaceBinding|null=null;
 private worktree='';
 private before=new Map<string,Record<string,string>>();
 private contracts=new Map<string,CheckContract>();
 private failure=new Map<string,string>();
 private recipes=new Map<string,Recipe>();
 private gates=new Map<string,ActionGate>();
 constructor(private plan:BatchPlan,private proof:string,private contractRoot:string){}
 verifyApproval(p:BatchPlan,d:string){return verifyBatchApproval(p,d);}
 private async contract(t:FrozenTranche){
  if(!safeId.test(t.id)||!this.contractRoot)throw Error('CHECK_CONTRACT_UNAVAILABLE');
  const x=JSON.parse(await readFile(path.join(this.contractRoot,t.id+'.json'),'utf8')) as CheckContract;
  checkContract(x);if(sha(canonical(x))!==t.verificationContractDigest)throw Error('CHECK_CONTRACT_DRIFT');
  this.contracts.set(t.id,x);return x;
 }
 private async loadRecipe(t:FrozenTranche){
  const dir=process.env.GACM_BATCH_RECIPE_DIR;
  if(!safeId.test(t.id)||!dir)throw Error('EXECUTION_RECIPE_NOT_CONNECTED');
  const r=JSON.parse(await readFile(path.join(dir,t.id+'.json'),'utf8')) as Recipe;
  validateRecipe(r,t.id);
  if(recipeDigest(r)!==t.executionRecipeDigest||r.steps.length!==2)throw Error('EXECUTION_RECIPE_DIGEST_OR_SEQUENCE_DRIFT');
  this.recipes.set(t.id,r);return r;
 }
 private async identity(){
  if(!this.binding)throw Error('NO_BATCH_WORKTREE');
  const [r,b,shaAtHead]=await Promise.all([git(this.worktree,'remote','get-url','origin'),
   git(this.worktree,'branch','--show-current'),git(this.worktree,'rev-parse','HEAD')]);
  if(!sameRemote(r,this.plan.repository)||b!==this.binding.executionBranch||shaAtHead!==this.plan.startSha||
     this.binding.trancheId!==this.plan.batchId||path.resolve(this.binding.workspacePath)!==path.resolve(this.worktree))
    throw Error('BATCH_WORKSPACE_DRIFT');
 }
 async preflight(p:BatchPlan,s:BatchState){
  const project=p.project as ProjectKey;
  if(!Object.hasOwn(PROJECTS,project)||!sameRemote(projectConfig(project).expectedRemote,p.repository))
    throw Error('UNAPPROVED_PROJECT_OR_REMOTE');
  if(!this.binding){
   const cfg=projectConfig(project);
   const a={runId:'batch-'+p.batchId,trancheId:p.batchId,repositoryRole:project.toUpperCase()+'_PROJECT',
    repositoryRoot:cfg.root,repositoryIdentity:p.repository,expectedRemote:p.repository,
    authoritativeRef:p.approvedBranch,authoritativeSha:p.startSha,executionRoot:cfg.executionRoot};
   const x=await reconcileExecutionWorkspace(a,async(cwd:string,args:string[])=>git(cwd,...args));
   this.binding=x.binding;this.worktree=x.binding.workspacePath;
  }
  await this.identity();
  const auth=await cmd(process.execPath,[CODEX_CLI_JS,'login','status'],this.worktree,30000);
  if(auth.code||!/Logged in using ChatGPT/i.test(auth.stdout+'\n'+auth.stderr))throw Error('SUBSCRIPTION_AUTH_NOT_VERIFIED');
  for(const t of p.tranches){await this.contract(t);await this.loadRecipe(t);}
  const current=await snapshot(this.worktree,p.startSha);
  if(s.lastCandidate&&(s.lastCandidate.workspaceId!==this.worktree||s.lastCandidate.changeDigest!==current.digest))
    throw Error('CANDIDATE_CHANGED_ON_CONTINUATION');
 }
 async execute(p:BatchPlan,t:FrozenTranche,attempt:number,op:string,prior:Candidate|null):Promise<ExecutionReceipt>{
  await this.identity();
  const initial=await snapshot(this.worktree,p.startSha);
  const runId=p.batchId+'-'+t.id+'-'+attempt;
  const recipe=this.recipes.get(t.id);if(!recipe)throw Error('RECIPE_MISSING');
  const gate=new ActionGate(recipe,t.id);
  const step=gate.currentStep.step_id,action=runId+'-codex';
  gate.authorize({action_id:action,step_id:step,action_kind:'CODEX_EXECUTE',tool:'codex-cli',
   target:p.repository,parameters:{tranche:t.id,model:p.model,effort:p.reasoningEffort,attempt}});
  this.gates.set(runId,gate);
  this.before.set(runId,initial.hashes);
  const finalFile=path.join(this.proof,runId+'-final.txt');
  const prompt=['GACM frozen batch '+p.batchId+' tranche '+t.id+' attempt '+attempt+'.',
    'Objective: '+t.objective,'Allowed: '+t.allowedPaths.join(', ')+'; forbidden: '+t.forbiddenPaths.join(', '),
    'Preserve the existing candidate, do not reset/stash/commit/push/deploy, use no network, no other models or agents.',
    'Only current approved tranche. Independent verification occurs outside Codex.',
    attempt>1?'Previous independent failure: '+(this.failure.get(t.id)||'UNAVAILABLE'):'',
    'Report RESULT, BLOCKER, NEXT ACTION; never self-certify acceptance.'].filter(Boolean).join('\n');
  const r=await cmd(process.execPath,[CODEX_CLI_JS,'exec','-C',this.worktree,'-m',p.model,
    '-c','model_reasoning_effort="medium"','--sandbox','workspace-write','-c','windows.sandbox="unelevated"',
    '-c','approval_policy="never"','-c','sandbox_workspace_write.network_access=false',
    '--output-last-message',finalFile,prompt],this.worktree,p.maxDurationSeconds*1000);
  await writeFile(path.join(this.proof,runId+'-codex.log'),r.stdout+'\nSTDERR:\n'+r.stderr,'utf8');
  const candidate=await snapshot(this.worktree,p.startSha);
  const finalText=await readFile(finalFile,'utf8').catch(()=>'');
  const blocked=r.code!==0||/(?:^|\n)RESULT:\s*(?:\n)?\s*(?:HOLD|BLOCKED|FAIL)/i.test(finalText);
  if(!blocked)gate.recordResult(action,'EXECUTED',[path.join(this.proof,runId+'-codex.log')]);
  return {runId,candidate:{workspaceId:this.worktree,sourceSha:p.startSha,changeDigest:candidate.digest,changedPaths:candidate.names},
    model:p.model,effort:p.reasoningEffort,status:blocked?'BLOCKED':'EXECUTED',
    failureReason:blocked?'EXECUTOR_EXIT_OR_HOLD_'+r.code:undefined};
 }
 async verifyCandidateScope(p:BatchPlan,t:FrozenTranche,r:ExecutionReceipt){
  const old=this.before.get(r.runId);if(!old)throw Error('MISSING_PRE_EXECUTION_SNAPSHOT');
  const x=await snapshot(this.worktree,p.startSha);if(x.digest!==r.candidate.changeDigest)throw Error('POST_EXECUTION_CANDIDATE_DRIFT');
  const modified=[...new Set([...Object.keys(old),...Object.keys(x.hashes)])].filter(n=>old[n]!==x.hashes[n]);
  for(const n of modified)if(!t.allowedPaths.some(p=>pathMatch(p,n))||t.forbiddenPaths.some(p=>pathMatch(p,n)))
    throw Error('TRANCHE_PATH_ESCAPED:'+n);
 }
 private async checks(t:FrozenTranche){
  const contract=this.contracts.get(t.id)||await this.contract(t);
  const refs:string[]=[];
  for(const c of contract.checks){
   const before=await snapshot(this.worktree,this.plan.startSha);
   const r=await cmd(c.executable,c.args,this.worktree,c.timeoutSeconds*1000).catch(e=>({code:-1,stdout:'',stderr:String(e)}));
   const after=await snapshot(this.worktree,this.plan.startSha);
   const ref=path.join(this.proof,'verify-'+t.id+'-'+c.id+'-'+Date.now()+'.json');
   await writeFile(ref,JSON.stringify({check:c,code:r.code,stdout:r.stdout,stderr:r.stderr,candidate:before.digest,after:after.digest})+'\n');
   refs.push(ref);
   if(before.digest!==after.digest)return {status:'HOLD' as const,refs,reason:'VERIFIER_MUTATED_CANDIDATE',family:c.id};
   if(r.code)return {status:'FAIL' as const,refs,reason:r.stderr.slice(0,500)||'CHECK_NONZERO_EXIT',family:c.id};
  }
  return {status:'PASS' as const,refs,reason:'',family:''};
 }
 async verify(p:BatchPlan,t:FrozenTranche,r:ExecutionReceipt):Promise<VerificationReceipt>{
  if((await snapshot(this.worktree,p.startSha)).digest!==r.candidate.changeDigest)throw Error('PRE_VERIFICATION_DRIFT');
  const gate=this.gates.get(r.runId);if(!gate)throw Error('ACTION_GATE_MISSING');
  const step=gate.currentStep.step_id,action=r.runId+'-verifier';
  gate.authorize({action_id:action,step_id:step,action_kind:'INDEPENDENT_VERIFY',tool:'gacm-local-verifier',
   target:p.repository,parameters:{tranche:t.id,contractDigest:t.verificationContractDigest,
    candidateDigest:r.candidate.changeDigest}});
  const x=await this.checks(t);
  gate.recordResult(action,'VERIFIED',x.refs);
  await writeFile(path.join(this.proof,r.runId+'-action-authority.json'),
   JSON.stringify({recipeDigest:recipeDigest(gate.recipe),state:gate.authorityState,
    decisions:gate.decisions,transitions:gate.transitions})+'\n');
  if(gate.authorityState!=='VERIFICATION')throw Error('RECIPE_NOT_VERIFIED');
  if(x.status!=='PASS')this.failure.set(t.id,x.family+':'+x.reason);
  return {status:x.status,issuerRole:'INDEPENDENT_VERIFIER',runId:r.runId,changeDigest:r.candidate.changeDigest,
   contractDigest:t.verificationContractDigest,evidenceRefs:x.refs,defectFamily:x.family,reason:x.reason};
 }
 async revalidateAccepted(p:BatchPlan,s:BatchState,c:Candidate){
  if((await snapshot(this.worktree,p.startSha)).digest!==c.changeDigest)throw Error('REVALIDATION_CANDIDATE_DRIFT');
  const ids=s.accepted.map(x=>x.trancheId),refs:string[]=[];
  for(const id of ids){
   const t=p.tranches.find(x=>x.id===id);if(!t)throw Error('ACCEPTED_TRANCHE_NOT_FOUND');
   const check=await this.checks(t);refs.push(...check.refs);
   if(check.status!=='PASS')return {status:check.status,issuerRole:'INDEPENDENT_VERIFIER',
    candidateChangeDigest:c.changeDigest,acceptedTrancheIds:ids,evidenceRefs:refs};
  }
  return {status:'PASS' as const,issuerRole:'INDEPENDENT_VERIFIER',candidateChangeDigest:c.changeDigest,
   acceptedTrancheIds:ids,evidenceRefs:refs};
 }
}
/** Caller uses signed batch approval; default no approval directory/key => HOLD. */
export async function runApprovedBatch(plan:BatchPlan):Promise<BatchState>{
 if(!Object.hasOwn(PROJECTS,plan.project))throw Error('UNKNOWN_PROJECT');
 const root=projectConfig(plan.project as ProjectKey).proofRoot;
 const release=await acquireExecutionLock(projectConfig('gacm').proofRoot,'batch-'+plan.batchId);
 try{
  const proof=path.join(root,'BATCH-'+plan.batchId);await mkdir(proof,{recursive:true});
  const planFile=path.join(proof,'frozen-plan.json'),body=canonical(plan)+'\n';
  const current=await readFile(planFile,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(current!==null&&current!==body)throw Error('FROZEN_PLAN_CHANGED');
  if(current===null)await writeFile(planFile,body,{flag:'wx'});
  const adapter=new LiveAdapters(plan,proof,process.env.GACM_BATCH_CONTRACT_DIR||'');
  return await new BatchCoordinator(adapter,new JsonBatchStateStore(path.join(proof,'state'))).run(plan);
 }finally{await release();}
}

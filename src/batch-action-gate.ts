/** Mirror of GACM_EXECUTION_RECIPE_V1 per-action ALLOW/DENY contract. */
import {createHash} from 'node:crypto';
import {canonical} from './batch-coordinator.js';
type Rule={action_kind:string;tools:string[];target_patterns:string[];
 parameter_constraints:{allowed_keys:string[];required_keys:string[];exact?:Record<string,unknown>;
 allowed_values?:Record<string,unknown[]>;string_prefixes?:Record<string,string[]>};judgment_slot_id:string|null};
type Step={step_id:string;sequence:number;allowed_actions:Rule[];bounded_judgment_slots:unknown[];
 acceptable_prior_states:string[];expected_result_states:string[];evidence_requirements:string[];stop_conditions:string[]};
export type Recipe={schema:'GACM_EXECUTION_RECIPE_V1';recipe_id:string;version:string;state:'FROZEN';
 work_unit_id:string;mutation_policy:'GOVERNED_REFREEZE_REQUIRED';steps:Step[]};
export type ProposedAction={action_id:string;step_id:string;action_kind:string;tool:string;target:string;
 parameters:Record<string,unknown>};
export function recipeDigest(recipe:Recipe){return createHash('sha256').update(canonical(recipe)).digest('hex');}
function match(pattern:string,value:string){const e=pattern.split('*').map(s=>s.replace(/[.*+?^$()|[\]{}\\]/g,'\\$&')).join('.*');
 return new RegExp('^'+e+'$').test(value);}
function keysSame(obj:object,expected:string[]){
 const a=Object.keys(obj).sort(),b=[...expected].sort();
 if(canonical(a)!==canonical(b))throw Error('RECIPE_FIELD_SET_MISMATCH');
}
export function validateRecipe(r:Recipe,workUnitId:string){
 if(!r||typeof r!=='object')throw Error('MISSING_RECIPE');
 keysSame(r,['schema','recipe_id','version','state','work_unit_id','mutation_policy','steps']);
 if(r.schema!=='GACM_EXECUTION_RECIPE_V1'||r.state!=='FROZEN'||r.work_unit_id!==workUnitId||
   r.mutation_policy!=='GOVERNED_REFREEZE_REQUIRED'||!r.recipe_id||!r.version||!Array.isArray(r.steps)||!r.steps.length)
   throw Error('UNAUTHORIZED_RECIPE');
 const seen=new Set<string>();
 for(const [index,s] of r.steps.entries()){
  keysSame(s,['step_id','sequence','allowed_actions','bounded_judgment_slots','acceptable_prior_states','expected_result_states',
    'evidence_requirements','stop_conditions']);
  if(!s.step_id||seen.has(s.step_id)||s.sequence!==index+1||!Array.isArray(s.allowed_actions)||!s.allowed_actions.length||
    !Array.isArray(s.bounded_judgment_slots)||!Array.isArray(s.acceptable_prior_states)||!s.acceptable_prior_states.length||
    !Array.isArray(s.expected_result_states)||!s.expected_result_states.length||
    !Array.isArray(s.evidence_requirements)||!s.evidence_requirements.length||
    !Array.isArray(s.stop_conditions)||!s.stop_conditions.length)throw Error('INVALID_RECIPE_STEP');
  seen.add(s.step_id);
  // This opt-in adapter cannot exercise judgment slots. Explicit nonempty slots fail closed.
  if(s.bounded_judgment_slots.length)throw Error('JUDGMENT_SLOT_NOT_IMPLEMENTED');
  for(const rule of s.allowed_actions){
   keysSame(rule,['action_kind','tools','target_patterns','parameter_constraints','judgment_slot_id']);
   if(!rule.action_kind||!rule.tools?.length||!rule.target_patterns?.length||
      !rule.parameter_constraints||rule.judgment_slot_id!==null)throw Error('UNSAFE_ACTION_RULE');
   const c=rule.parameter_constraints;
   if(!Array.isArray(c.allowed_keys)||!Array.isArray(c.required_keys)||
      c.required_keys.some(x=>!c.allowed_keys.includes(x)))throw Error('INVALID_PARAMETER_CONSTRAINTS');
  }
 }
 return r;
}
export class ActionGate{
 private state:'EXECUTION'|'VERIFICATION'|'BLOCKED'='EXECUTION';
 private index=0;
 private pending=new Set<string>();
 readonly decisions:Array<{action:string;result:string;step:string}>=[];
 readonly transitions:Array<{action:string;result:string;evidence:string[]}>=[];
 constructor(readonly recipe:Recipe,workUnitId:string){
  validateRecipe(recipe,workUnitId);
 }
 get currentStep(){return this.recipe.steps[this.index];}
 get authorityState(){return this.state;}
 authorize(a:ProposedAction,observed:'EXECUTION'|'FROZEN'|'VERIFICATION'|'BLOCKED'|'DESIGN'='EXECUTION'){
  if(this.state!=='EXECUTION'||a.step_id!==this.currentStep.step_id||
    !this.currentStep.acceptable_prior_states.includes(observed)||this.pending.has(a.action_id))
    return this.deny(a);
  const rule=this.currentStep.allowed_actions.find(r=>r.action_kind===a.action_kind&&r.tools.includes(a.tool)&&
    r.target_patterns.some(p=>match(p,a.target)));
  if(!rule)return this.deny(a);
  const c=rule.parameter_constraints,keys=Object.keys(a.parameters);
  if(keys.some(k=>!c.allowed_keys.includes(k))||c.required_keys.some(k=>!keys.includes(k)))return this.deny(a);
  for(const [k,v] of Object.entries(c.exact||{}))if(!Object.is(a.parameters[k],v))return this.deny(a);
  for(const [k,allowed] of Object.entries(c.allowed_values||{}))if(!allowed.some(v=>Object.is(a.parameters[k],v)))
    return this.deny(a);
  for(const [k,prefixes] of Object.entries(c.string_prefixes||{}))if(typeof a.parameters[k]!=='string'||
    !prefixes.some(p=>(a.parameters[k] as string).startsWith(p)))return this.deny(a);
  this.pending.add(a.action_id);this.decisions.push({action:a.action_id,result:'ALLOW',step:a.step_id});
  return 'ALLOW' as const;
 }
 private deny(a:ProposedAction){this.state='BLOCKED';this.decisions.push({action:a.action_id,result:'DENY',step:a.step_id});
  throw Error('ACTION_AUTHORITY_DENIED');}
 recordResult(action:string,result:string,evidence:string[]){
  if(this.state!=='EXECUTION'||!this.pending.has(action)||!this.currentStep.expected_result_states.includes(result)||
    !Array.isArray(evidence)||!evidence.length){this.state='BLOCKED';throw Error('ACTION_RESULT_NOT_AUTHORIZED');}
  this.pending.delete(action);this.transitions.push({action,result,evidence});
  if(this.index===this.recipe.steps.length-1)this.state='VERIFICATION';else this.index++;
 }
}

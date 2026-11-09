/** Shared fail-closed exclusivity between the existing Codex launcher and batch adapter. */
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
export async function acquireExecutionLock(proofRoot:string,owner:string):Promise<()=>Promise<void>>{
  if(!/^[\w.:-]{3,200}$/.test(owner))throw Error('INVALID_EXECUTION_LOCK_OWNER');
  await mkdir(proofRoot,{recursive:true});
  const file=path.join(proofRoot,'.gacm-execution.lock');
  const handle=await open(file,'wx');
  try{await handle.writeFile(JSON.stringify({owner,pid:process.pid,since:new Date().toISOString()})+'\n');}
  catch(e){await handle.close();await rm(file,{force:true});throw e;}
  let released=false;
  return async()=>{
    if(released)return;
    const body=await readFile(file,'utf8');
    if(JSON.parse(body).owner!==owner)throw Error('EXECUTION_LOCK_OWNER_DRIFT');
    await handle.close();await rm(file);released=true;
  };
}

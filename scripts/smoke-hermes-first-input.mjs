// Production Core + unmodified installed Hermes, deterministic local Responses.
// Captures actual model requests. Compression mode changes only this disposable
// fixture's window/tail and reports synthetic usage; it is not real-model QA.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startQualificationCore } from './lib/qualification-core.mjs'
import { createConfiguredCampAndSend, composerDocumentForAddress } from './lib/create-configured-camp.mjs'

assert(process.env.ROVAI_HERMES_BIN)
const compression = process.argv.includes('--compression')
const protectFirst = process.argv.includes('--unprotected') ? 0 : 3
const repository = resolve(import.meta.dirname, '..')
const root = await realpath(await mkdtemp(join(tmpdir(), 'rovai-hermes-first-input-')))
const home = join(root, 'home'), project = join(root, 'project'), data = join(root, 'data')
await mkdir(home, { mode: 0o700 }); await mkdir(project)
await writeFile(join(root, 'mcp.json'), '{}')
if (process.env.ROVAI_HERMES_DEPENDENCY_HOME) await symlink(join(process.env.ROVAI_HERMES_DEPENDENCY_HOME, 'installs'), join(home, 'installs'), 'dir')
const wire = [], results = []
let core, database, wireError, phase = 0, roundCall = 0, summaries = 0, requestCount = 0
function respond(response, body, item, inputTokens = 100) {
  const id = 'response-' + (++requestCount)
  const result = { id, object: 'response', status: 'completed', output: [item],
    usage: { input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10 } }
  if (!body.stream) { response.writeHead(200, {'content-type':'application/json'}); response.end(JSON.stringify(result)); return }
  response.writeHead(200, {'content-type':'text/event-stream'})
  let sequence = 0
  const emit = event => response.write('data: ' + JSON.stringify({...event, sequence_number: sequence++}) + '\n\n')
  emit({type:'response.created',response:{id,status:'in_progress',output:[]}})
  emit({type:'response.output_item.added',output_index:0,item})
  if (item.type === 'message') emit({type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:item.content[0].text})
  emit({type:'response.output_item.done',output_index:0,item})
  emit({type:'response.completed',response:result}); response.end()
}
const message = text => ({id:crypto.randomUUID(),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]})
const server = createServer(async(request,response)=>{
  try {
    if(request.method==='GET'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({object:'list',data:[{id:'fixture-model',object:'model'}]}));return}
    const chunks=[];for await(const chunk of request)chunks.push(chunk)
    const body=JSON.parse(Buffer.concat(chunks).toString())
    if(request.url==='/api/show'){response.writeHead(200,{'content-type':'application/json'});response.end('{}');return}
    assert(Array.isArray(body.input), 'Unexpected provider protocol: '+request.url)
    const main=Array.isArray(body.tools)&&body.tools.length>0
    wire.push({phase,main,body})
    if(!main){summaries++;respond(response,body,message('The earlier isolated acceptance tasks completed. Continue with the current request.'));return}
    roundCall++
    if(roundCall===1){
      respond(response,body,{id:crypto.randomUUID(),type:'function_call',call_id:crypto.randomUUID(),name:'terminal',
        arguments:JSON.stringify({command:`rovai send --public-only --body HERMES_RULES_PHASE_${phase}`}),status:'completed'},compression&&[3,4].includes(phase)?60000:100)
    }else{respond(response,body,message('Done.'))}
  }catch(error){wireError=error;response.writeHead(500);response.end()}
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const config={model:{provider:'fixture',default:'fixture-model',...(compression?{context_length:65536}:{})},
  // Keep this loopback fixture offline during native --version's passive update check.
  updates:{check:false},
  providers:{fixture:{base_url:`http://127.0.0.1:${server.address().port}/v1`,api_key_env:'ROVAI_HERMES_FIXTURE_KEY',transport:'codex_responses',models:['fixture-model']}},
  platform_toolsets:{acp:['terminal','no_mcp']},session_title:{enabled:false},agent:{max_turns:8,system_prompt:'NATIVE_CONFIG_SYSTEM_639'},
  compression:compression?{enabled:true,threshold:0.5,protect_first_n:protectFirst,protect_last_n:2}:{enabled:false}}
await writeFile(join(home,'config.yaml'),JSON.stringify(config),{mode:0o600})
const coreOptions={coreExecutable:join(repository,'target/debug/rovai-core'),dataDirectory:data,workingDirectory:repository,
  runtimeCacheDirectory:join(root,'cache'),mcpConfigPath:join(root,'mcp.json'),
  environmentOverrides:{HERMES_HOME:home,HERMES_DISABLE_LAZY_INSTALLS:'1',HERMES_EPHEMERAL_SYSTEM_PROMPT:'',ROVAI_HERMES_FIXTURE_KEY:'controlled-fixture'}}
console.log('Automatic acceptance:',JSON.stringify({root,data,skillLibrary:join(data,'managed-skill-library'),home,compression,config:config.compression}))
async function waitFor(fn,timeout=120000){const until=Date.now()+timeout;while(Date.now()<until){if(wireError)throw wireError;const result=await fn();if(result)return result;await new Promise(done=>setTimeout(done,100))}throw new Error('Acceptance timed out')}
const sql=(query,...args)=>database.prepare(query).get(...args)
try{
  core=startQualificationCore(coreOptions);await core.request('health.check')
  await waitFor(async()=>!(await core.request('runtime.status.get')).runtimeAvailability.some(row=>row.runtimeKind==='hermes-cli'&&row.discovery.discoveryStatus==='detecting'))
  await core.request('runtime.product.check',{runtimeKind:'hermes-cli'})
  const installation=await waitFor(async()=>{const row=(await core.request('runtime.installations.list')).find(row=>row.adapterKind==='hermes-cli'&&row.installationClass==='managed_default');if(['probe_failed','missing_capabilities'].includes(row?.snapshot?.probeStatus))throw new Error(row.snapshot.lastError);return row?.snapshot?.probeStatus==='ready'&&row})
  let member=await core.request('members.get',{agentId:'agent_2'})
  assert.equal((await core.request('members.runtime.set',{commandId:crypto.randomUUID(),command:{agentId:'agent_2',expectedVersion:member.version,adapterKind:'hermes-cli',model:installation.memberRuntimeDefaults.model,permissions:installation.memberRuntimeDefaults.permissions}})).status,'applied')
  let thread, nativeId, previousRequested=0
  database=new DatabaseSync(join(data,'rovai.sqlite'),{readOnly:true})
  for(phase=0;phase<(compression?7:4);phase++){
    roundCall=0
    if(phase===2||phase===6){await core.stop();core=startQualificationCore(coreOptions);await core.request('health.check')}
    if(phase===3){
      member=await core.request('members.get',{agentId:'agent_2'})
      assert.equal((await core.request('members.update',{commandId:crypto.randomUUID(),command:{agentId:'agent_2',expectedVersion:member.version,
        displayName:'Hermes identity updated',teamRole:member.teamRole,professionalResponsibilities:member.professionalResponsibilities,
        personalityTraits:member.personalityTraits,workingPrinciples:member.workingPrinciples,growthTopic:member.growthTopic}})).status,'applied')
    }
    const body=`Isolated task HERMES_TASK_${phase}: publish the phase marker with rovai send --public-only, then finish.`
    const sent=phase===0?await createConfiguredCampAndSend(core.request,{commandId:crypto.randomUUID(),name:'Hermes first-input acceptance',purpose:'User-layer rules and exact acceptance',body,memberAgentIds:['agent_2'],defaultLeadAgentId:'agent_2',workspace:{projectPath:project}}):await core.request('thread.messages.send',{commandId:crypto.randomUUID(),threadId:thread,
      content:composerDocumentForAddress({mode:'explicit',agentIds:['agent_2']},body),sourceAttachments:[],quotes:[],replyToThreadMessageId:null,deliveryMode:'start',execution:{taskId:null,purpose:'Rules acceptance',completionRole:'required'}})
    if(phase===0)thread=sent.payload.threadId??sent.payload.campId
    const run=await waitFor(()=>{const row=sql('SELECT id,status FROM agent_run WHERE camp_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',thread);return row&&['succeeded','failed','cancelled'].includes(row.status)&&!results.some(r=>r.run===row.id)&&row})
    assert.equal(run.status,'succeeded',JSON.stringify(run))
    const delivery=sql('SELECT * FROM runtime_input_delivery WHERE agent_run_id=? AND input_kind=\'start\'',run.id)
    const binding=sql('SELECT native_session_id FROM conversation WHERE camp_id=? AND agent_id=?',thread,'agent_2')
    nativeId??=binding.native_session_id;assert.equal(binding.native_session_id,nativeId)
    assert.equal(delivery.status,'accepted')
    const expected=phase===0?'initial':phase===3?'update':previousRequested?'compaction_recovery':'none'
    assert.equal(delivery.hermes_rules_delivery_kind,expected)
    const blob=sql('SELECT storage_relative_path FROM managed_blob WHERE id=?',delivery.hermes_runtime_payload_blob_id)
    const payload=await readFile(join(data,'managed-blobs',blob.storage_relative_path),'utf8')
    assert.equal(payload.split('[MEMBER_IDENTITY]').length-1,expected==='none'?0:1)
    assert(payload.includes(`HERMES_TASK_${phase}`))
    const first=wire.find(row=>row.phase===phase&&row.main).body
    const system=(first.instructions??'')+JSON.stringify(first.input.filter(m=>['system','developer'].includes(m.role)))
    assert(system.includes('NATIVE_CONFIG_SYSTEM_639'));assert(!system.includes('[SESSION_CHARTER]'))
    // Native Gateway trims the submitted message edges before the API call.
    // Core's frozen transport text remains unchanged; all rule/task content must match.
    assert(first.input.some(m=>m.role==='user'&&m.content===payload.trim()),'Actual user request differs from native-trimmed frozen payload')
    const requirement=sql('SELECT requested_revision,acknowledged_revision FROM bootstrap_redelivery_requirement WHERE native_binding_id=?',delivery.native_binding_id)
    previousRequested=requirement&&requirement.requested_revision>requirement.acknowledged_revision?requirement.requested_revision:0
    results.push({phase,run:run.id,kind:expected,requested:requirement?.requested_revision??0,acknowledged:requirement?.acknowledged_revision??0,mainRequests:wire.filter(r=>r.phase===phase&&r.main).length})
    console.log('Phase:',JSON.stringify(results.at(-1)))
  }
  if(compression){assert(summaries>=2,'Two native automatic summaries not observed');assert(results.at(-1).acknowledged>=2,'Completed native hooks did not trigger accepted recovery');assert.equal(results.at(-1).kind,'none','Post-compaction cold resume duplicated accepted rules');assert.equal(previousRequested,0)}
  const summary={version:installation.snapshot.reportedVersion,compression,protectFirst,syntheticProvider:true,nativeSessionUnchanged:true,summaries,results}
  await writeFile(join(root,'summary.json'),JSON.stringify(summary,null,2))
  console.log('Hermes first-input acceptance passed:',root)
}catch(error){console.error(error);throw error}finally{
  await writeFile(join(root,'wire.json'),JSON.stringify(wire,null,2))
  database?.close();if(core){const stopped=await core.stop();await writeFile(join(root,'core-stderr.log'),stopped.stderrTail??'')}
  server.closeAllConnections();await new Promise(done=>server.close(done))
}

// Real installed Hermes, deterministic local Responses endpoint. Tests input
// placement, turn-delta usage and native API failure, not model quality.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openHermesAcp } from './lib/hermes-native-acp.mjs'

assert(process.env.ROVAI_HERMES_BIN)
const root = await realpath(await mkdtemp(join(tmpdir(), 'rovai-hermes-wire-')))
const home = join(root,'home'), project=join(root,'project')
await mkdir(home,{mode:0o700}); await mkdir(project)
let fail = false, wireError, count = 0, holdNext = false, releaseHeld
const wire = []
const server = createServer(async (request,response)=>{
  try {
    if(request.method==='GET') {
      response.writeHead(200,{'content-type':'application/json'})
      response.end(JSON.stringify({object:'list',data:[{id:'fixture-model',object:'model'}]}));return
    }
    const chunks=[]; for await(const c of request)chunks.push(c)
    const body=JSON.parse(Buffer.concat(chunks).toString());
    if(!Array.isArray(body.input)){response.writeHead(200,{'content-type':'application/json'});response.end('{}');return}
    wire.push(body)
    if(holdNext){holdNext=false;await new Promise(done=>{releaseHeld=done})}
    if(fail){response.writeHead(401,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'Controlled invalid credential',type:'authentication_error',code:'invalid_api_key'}}));return}
    const id='fixture-'+(++count), item={id:'message-'+count,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'WIRE_OK',annotations:[]}]}
    response.writeHead(200,{'content-type':'text/event-stream'})
    let sequence=0
    const emit=e=>response.write('data: '+JSON.stringify({...e,sequence_number:sequence++})+'\n\n')
    emit({type:'response.created',response:{id,status:'in_progress',output:[]}})
    emit({type:'response.output_item.added',output_index:0,item:{...item,content:[]}})
    emit({type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:'WIRE_OK'})
    emit({type:'response.output_item.done',output_index:0,item})
    emit({type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:100,output_tokens:10,total_tokens:110,input_tokens_details:{cached_tokens:40},output_tokens_details:{reasoning_tokens:2}}}})
    response.end()
  }catch(error){wireError=error;response.writeHead(500);response.end()}
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
await writeFile(join(home,'config.yaml'),JSON.stringify({model:{provider:'fixture',default:'fixture-model'},
  providers:{fixture:{base_url:`http://127.0.0.1:${server.address().port}/v1`,api_key_env:'ROVAI_HERMES_FIXTURE_KEY',transport:'codex_responses',models:['fixture-model']}},
  platform_toolsets:{acp:['terminal','no_mcp']},session_title:{enabled:false},agent:{max_turns:2}}),{mode:0o600})
let client
try{
  client=await openHermesAcp({executable:process.env.ROVAI_HERMES_BIN,script:resolve(import.meta.dirname,'../crates/rovai-core/src/hermes/host.py'),cwd:project,
    env:{...process.env,HERMES_HOME:home,ROVAI_HERMES_FIXTURE_KEY:'controlled-fixture'}})
  const session=await client.request('session/new',{cwd:project,mcpServers:[]}), sessionId=session.sessionId
  const prompt=()=>client.request('session/prompt',{sessionId,prompt:[{type:'text',text:'ORDINARY-PAYLOAD-552'}]})
  await assert.rejects(prompt(),e=>e.rpcError?.code===-32002)
  for(const marker of ['BOOTSTRAP-ONE-771','BOOTSTRAP-TWO-882']){
    await assert.rejects(client.request('_rovai/bind',{sessionId,bootstrap:marker,sha256:'invalid'}),e=>e.rpcError?.code===-32602)
    await client.request('_rovai/bind',{sessionId,bootstrap:marker,sha256:createHash('sha256').update(marker).digest('hex')})
    const result=await prompt()
    assert.equal(result.stopReason,'end_turn')
    assert.equal(result.usage.inputTokens,100);assert.equal(result.usage.outputTokens,10)
    assert.equal(result.usage.cachedReadTokens,40);assert.equal(result.usage.thoughtTokens,2)
    const body=wire.at(-1)
    const system = (body.instructions ?? '') + JSON.stringify(body.input.filter(item => ['system','developer'].includes(item.role)))
    const ordinary = JSON.stringify(body.input.filter(item => !['system','developer'].includes(item.role)))
    assert(system.includes(marker),'Bootstrap absent from native system/developer messages')
    assert(!system.includes('ORDINARY-PAYLOAD-552'),'Ordinary payload promoted to system')
    assert(!ordinary.includes(marker),'Bootstrap copied into ordinary chat history')
    assert(ordinary.includes('ORDINARY-PAYLOAD-552'))
    if(marker.includes('TWO'))assert(!system.includes('BOOTSTRAP-ONE-771'),'Previous Bootstrap accumulated')
  }
  holdNext=true
  const active=prompt()
  const waitDeadline=Date.now()+15000
  while(!releaseHeld && Date.now()<waitDeadline)await new Promise(done=>setTimeout(done,20))
  assert(releaseHeld,'Controlled request never started')
  await assert.rejects(prompt(),e=>e.rpcError?.code===-32000)
  releaseHeld();releaseHeld=null
  assert.equal((await active).stopReason,'end_turn')
  fail=true
  await assert.rejects(prompt(),e=>e.rpcError?.code===-32003)
  if(wireError)throw wireError
  assert(wire.every(body => body.tools), 'Unowned background model request')
  const result={systemBinding:true,ordinaryPayload:true,rebind:true,turnDelta:true,nativeFailure:true,busyRejected:true,requests:wire.length}
  await writeFile(join(root,'summary.json'),JSON.stringify(result,null,2))
  console.log(root,JSON.stringify(result))
}finally{releaseHeld?.();if(client)console.log('Cleanup:',await client.close());server.closeAllConnections();await new Promise(done=>server.close(done))}

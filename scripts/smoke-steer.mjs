// Real Runtime acceptance; all Core, Skills, MCP, cache and workspace writes are isolated.
// node scripts/smoke-steer.mjs <new-empty-absolute-root> <absolute-core-executable>
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startQualificationCore } from './lib/qualification-core.mjs'
import { composerDocumentForAddress } from './lib/create-configured-camp.mjs'
const [fixture, executable] = process.argv.slice(2)
assert.ok(isAbsolute(fixture) && isAbsolute(executable))
await access(join(dirname(executable), process.platform === 'win32' ? 'rovai.exe' : 'rovai'))
assert.deepEqual(await readdir(fixture), [])
const data = join(fixture, 'core'), project = join(fixture, 'project')
await mkdir(data); await mkdir(project)
const report = { startedAt: new Date().toISOString(), coreExecutable: executable, coreSha256: createHash('sha256').update(await readFile(executable)).digest('hex'), fixture, cases: [], runtimes: [] }
console.error(`Automatic acceptance: data=${data}; skills=${join(data,'managed-skill-library')}; MCP=${join(data,'mcp.json')}; project=${project}`)
let core, db, threadId, failedExecution = () => null
async function wait(check, label, timeout=300_000) {
  const deadline = Date.now()+timeout
  while(Date.now()<deadline) { const value=await check();if(value)return value;const failure=failedExecution();if(failure)throw new Error(`Execution failed while waiting for ${label}: ${JSON.stringify(failure)}`);await new Promise(r=>setTimeout(r,200)) }
  throw new Error(`Timed out: ${label}`)
}
const exists = async name => { try { await access(join(project,name));return true } catch { return false } }
try {
  core = startQualificationCore({coreExecutable:executable,dataDirectory:data,workingDirectory:project,runtimeCacheDirectory:join(fixture,'cache'),mcpConfigPath:join(data,'mcp.json')})
  await core.request('health.check')
  await core.request('runtime.discovery.rescan',{interactiveShell:false})
  for(const adapter of ['codex-cli','opencode-cli']) await core.request('runtime.product.check',{runtimeKind:adapter},120_000)
  const installations = await core.request('runtime.installations.list')
  for(const [agentId,adapter] of [['agent_1','codex-cli'],['agent_2','opencode-cli'],['agent_3','codex-cli']]) {
    const installation=installations.find(i=>i.adapterKind===adapter&&i.installationClass==='managed_default'&&i.authScope==='default'&&i.memberRuntimeDefaults)
    assert.ok(installation,`${adapter} requires saved defaults`)
    const current=await core.request('members.get',{agentId})
    const result=await core.request('members.runtime.set',{commandId:randomUUID(),command:{agentId,expectedVersion:current.version,adapterKind:adapter,model:installation.memberRuntimeDefaults.model,permissions:installation.memberRuntimeDefaults.permissions}})
    assert.equal(result.status,'applied')
    report.runtimes.push({agentId,adapter,version:installation.snapshot?.reportedVersion ?? null,model:installation.memberRuntimeDefaults.model})
  }
  const created=await core.request('threads.create',{commandId:randomUUID(),name:'Steer isolated acceptance',workspace:{projectPath:project},memberAgentIds:['agent_1','agent_2','agent_3'],defaultLeadAgentId:'agent_1',collaborationMode:'peer'})
  assert.equal(created.status,'applied');threadId=created.payload.threadId
  db=new DatabaseSync(join(data,'rovai.sqlite'),{readOnly:true})
  failedExecution=()=>db.prepare("SELECT id,status,last_error_code,public_runtime_failure_json FROM agent_run WHERE camp_id=? AND status IN ('failed','cancelled') LIMIT 1").get(threadId)
  const runs=()=>db.prepare('SELECT r.id,c.agent_id,r.status,r.execution_epoch,r.last_error_code FROM agent_run r JOIN conversation c ON c.id=r.conversation_id WHERE r.camp_id=? ORDER BY r.created_at,r.id').all(threadId)
  const deliveries=messageId=>db.prepare('SELECT id,recipient_agent_id,status,requested_mode,claimed_agent_run_id,failure_code FROM camp_message_delivery WHERE message_id=? ORDER BY recipient_agent_id').all(messageId)
  const inputs=run=>db.prepare('SELECT i.id,i.status,i.native_input_id,i.input_kind,i.input_sequence,m.id AS manifest_id,m.source_delivery_id,m.raw_message_refs_json,m.attachment_refs_json,m.run_fact_payload_json FROM runtime_input_delivery i JOIN context_manifest m ON m.id=i.context_manifest_id WHERE i.agent_run_id=? ORDER BY input_sequence').all(run)
  const send=async (ids,body,mode='start',sourceAttachments=[])=>{
    const result=await core.request('thread.messages.send',{commandId:randomUUID(),threadId,content:composerDocumentForAddress({mode:'explicit',agentIds:ids},body),sourceAttachments,quotes:[],replyToThreadMessageId:null,deliveryMode:mode,steerTargets:runs().filter(r=>ids.includes(r.agent_id)&&r.status==='running').map(r=>({agentRunId:r.id,executionEpoch:r.execution_epoch})),execution:{taskId:null,purpose:'Steer isolated acceptance',completionRole:'required'}})
    assert.equal(result.commandResult.status,'accepted',JSON.stringify(result));return result.commandResult.payload.threadMessageId
  }
  await writeFile(join(project,'hold.mjs'),`import {access,writeFile} from 'node:fs/promises';const id=process.argv[2];await writeFile(id+'.ready','ready');while(true){try{await access(id+'.release');break}catch{await new Promise(r=>setTimeout(r,100))}}console.log('HOLD_COMPLETE');\n`)
  await send(['agent_1'],'隔离验收：执行 node ./hold.mjs codex，不修改脚本。工具结束后按本轮后续用户输入完成；若无后续输入只报告 ORIGINAL。用 rovai send --public-only 公开结果，不联系其他队员。')
  await wait(()=>exists('codex.ready'),'Codex tool boundary')
  const codexRun=runs().find(r=>r.agent_id==='agent_1').id
  const initial=inputs(codexRun);assert.equal(initial.length,1);assert.equal(initial[0].status,'accepted')
  const ordinary=await send(['agent_1'],'请把 ORDINARY_QUEUE 写入 ordinary.txt，然后用 rovai send --public-only 报告。')
  const text=await send(['agent_1'],'补充要求：工具结束后把 STEER_TEXT_成功 写入 text-result.txt。保留后续附件要求。','steer')
  await wait(()=>inputs(codexRun).find(i=>i.source_delivery_id===deliveries(text)[0].id&&i.status==='accepted'),'text input accepted',60_000)
  const attachmentPath=join(project,'steer-attachment.txt')
  await writeFile(attachmentPath,'这是本轮补充要求：把 ATTACHMENT_成功 写入 attachment-result.txt，完成后用 rovai send --public-only 报告 STEER_TEXT_成功 ATTACHMENT_成功。')
  const attachment=await send(['agent_1'],'','steer',[{id:randomUUID(),sourcePath:attachmentPath,displayName:'steer-attachment.txt',kind:'file',mediaType:'text/plain',observedByteSize:Buffer.byteLength(await readFile(attachmentPath))}])
  await wait(()=>inputs(codexRun).find(i=>i.source_delivery_id===deliveries(attachment)[0].id&&i.status==='accepted'),'attachment-only accepted',60_000)
  assert.equal(deliveries(ordinary)[0].status,'waiting')
  const three=inputs(codexRun);assert.equal(three.length,3);assert.equal(new Set(three.map(i=>i.native_input_id)).size,1)
  for(const [i,id] of [[three[1],text],[three[2],attachment]]) assert.deepEqual(JSON.parse(i.raw_message_refs_json).map(r=>r.entityId),[id])
  assert.ok(JSON.parse(three[2].attachment_refs_json).some(a=>a.path===attachmentPath))
  await writeFile(join(project,'codex.release'),'release')
  await wait(()=>runs().find(r=>r.id===codexRun&&['succeeded','failed','cancelled'].includes(r.status)),'Codex terminal')
  assert.equal(runs().find(r=>r.id===codexRun).status,'succeeded')
  assert.equal((await readFile(join(project,'text-result.txt'),'utf8')).trim(),'STEER_TEXT_成功')
  assert.equal((await readFile(join(project,'attachment-result.txt'),'utf8')).trim(),'ATTACHMENT_成功')
  await wait(()=>runs().every(r=>!['queued','running','waiting'].includes(r.status)),'ordinary completion')
  assert.equal((await readFile(join(project,'ordinary.txt'),'utf8')).trim(),'ORDINARY_QUEUE')
  assert.equal(runs().filter(r=>r.agent_id==='agent_1').length,2)
  report.cases.push({name:'same-turn text + attachment-only + ordinary queue separation',status:'passed',inputs:three})
  await send(['agent_1'],'执行 node ./hold.mjs mixed-codex，不修改脚本。结束后把后续用户要求写入 mixed-codex.txt 并用 rovai send --public-only 报告；无后续要求写 ORIGINAL。')
  await send(['agent_2'],'执行 node ./hold.mjs mixed-opencode，不修改脚本。结束后用 rovai send --public-only 报告 ORIGINAL，并在最终回复中再次输出 ORIGINAL。')
  await wait(()=>exists('mixed-codex.ready'),'mixed Codex boundary');await wait(()=>exists('mixed-opencode.ready'),'mixed OpenCode boundary')
  const multi=await send(['agent_1','agent_2','agent_3'],'隔离多队员要求 MIXED_成功：agent_1 写入 mixed-codex.txt；agent_2 写入 mixed-opencode.txt；agent_3 写入 mixed-idle.txt。各自只写自己的文件，用 rovai send --public-only 报告，并在最终回复中再次输出 MIXED_成功。','steer')
  await wait(()=>deliveries(multi).find(d=>d.recipient_agent_id==='agent_1')?.status==='settled','mixed steer accepted')
  const route=deliveries(multi)
  assert.equal(route[0].requested_mode,'steer');assert.equal(route[1].requested_mode,'start');assert.equal(route[1].status,'waiting');assert.equal(route[2].requested_mode,'start')
  await wait(()=>exists('mixed-idle.txt'),'idle independent start')
  await writeFile(join(project,'mixed-codex.release'),'release');await writeFile(join(project,'mixed-opencode.release'),'release')
  for(const name of ['mixed-codex.txt','mixed-opencode.txt'])await wait(()=>exists(name),name)
  await wait(()=>runs().every(r=>!['queued','running','waiting'].includes(r.status)),'mixed terminal')
  for(const name of ['mixed-codex.txt','mixed-opencode.txt','mixed-idle.txt'])assert.ok((await readFile(join(project,name),'utf8')).includes('MIXED_成功'))
  report.cases.push({name:'one public multi-mention: capable busy / unsupported busy / idle',status:'passed',routes:route})
  report.runs=runs();report.status='passed'
} catch(error) {report.status='failed';report.error=error.stack;process.exitCode=1}
finally {
  for(const name of ['codex','mixed-codex','mixed-opencode'])await writeFile(join(project,`${name}.release`),'release')
  db?.close();if(core)report.coreExit=await core.stop()
  report.finishedAt=new Date().toISOString();await writeFile(join(fixture,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}

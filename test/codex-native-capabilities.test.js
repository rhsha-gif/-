import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadDefinitions,renderDefinitions} from '../src/definitions.js';
import {resolveRoleAgent} from '../src/role-agent.js';
import {buildCodexCommand} from '../src/providers/codex-cli.js';
import {selectCapabilities} from '../src/capabilities.js';

test('ship and invest-judge execute natively on Codex without a Claude bridge', async () => {
  const defs=await loadDefinitions({includeUser:true,cwd:os.tmpdir()});
  const selected=selectCapabilities({requestedIds:['ship','invest-judge'],inventory:defs,provider:{id:'openai',adapter:'codex'}});
  assert.equal(selected.skills.length,2);
  const files=await renderDefinitions({definitions:defs.filter(d=>['ship','invest-judge'].includes(d.id)),target:'codex',installScope:'user'});
  for(const file of files.filter(f=>f.path.endsWith('SKILL.md'))) {
    assert.equal(file.mode,'native');
    assert.doesNotMatch(file.content.toString(),/requires anthropic|mode=bridge/);
  }
});

test('no-shell native presets and dispatched commands preserve restrictions and scoped file access',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'aorch-codex-native-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'.agents/aorch');await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'review.md'),'Read evidence. Do not compute, write or delegate.');
  const manifest={version:1,agents:[{id:'restricted-review',description:'Read-only review',instructions:'review.md',providers:{openai:{sandbox_mode:'read-only',features:{shell_tool:false,unified_exec:true},ship_triggers:['src/**']}}}]};
  await writeFile(path.join(dir,'definitions.json'),JSON.stringify(manifest));
  const [definition]=await loadDefinitions({cwd:root,includeShared:false});
  const [rendered]=await renderDefinitions({definitions:[definition],target:'codex'});
  assert.match(rendered.content,/features\.shell_tool = false/);
  assert.match(rendered.content,/features\.unified_exec = false/);
  assert.match(rendered.content,/features\.multi_agent = false/);
  assert.match(rendered.content,/requires isolated aorch execution/);
  assert.doesNotMatch(rendered.content,/mcp_servers\./);
  assert.doesNotMatch(rendered.content,/^ship_triggers =/m);
  const nativePath=path.join(root,rendered.path);await mkdir(path.dirname(nativePath),{recursive:true});await writeFile(nativePath,rendered.content);
  definition.bindings.openai.path=nativePath;
  const role=await resolveRoleAgent({config:{capabilities:[definition]},agentId:definition.id,agentRole:'reviewer',adapter:'codex',cwd:root});
  const command=buildCodexCommand({prompt:'Read result.json',route:{model:'gpt-5.6-terra',effort:'high'},...role});
  assert.ok(command.args.includes('--ignore-user-config'));
  assert.ok(role.agentInstructions.startsWith('Read evidence. Do not compute, write or delegate.'));
  assert.match(role.agentInstructions,/AGENTS.md/);
  for(const feature of ['shell_tool','unified_exec','multi_agent','multi_agent_v2','hooks','plugins','apps'])assert.ok(command.args.includes(`features.${feature}=false`));
  assert.equal(role.sandboxMode,'read-only');
  assert.equal(role.mcpServers.aorch_files.args.at(-1),root);
  assert.equal(role.mcpServers.aorch_files.args.at(-2),'--root');
  assert.throws(()=>buildCodexCommand({prompt:'x',route:{model:'gpt-5.6-terra',effort:'high'},...role,write:true}),/requires read-only/);
  assert.throws(()=>buildCodexCommand({prompt:'x',route:{model:'gpt-5.6-terra',effort:'high'},...role,mcpServers:{unrelated:{command:'node'}}}),/only the scoped/);
  const paperCommand=buildCodexCommand({prompt:'Find sources',route:{model:'gpt-5.6-terra',effort:'high'},mcpServers:{'paper-search':{command:'uvx',enabled_tools:['search_papers']}}});
  assert.ok(paperCommand.args.includes('mcp_servers.paper-search.enabled_tools=["search_papers"]'));
  manifest.agents[0].providers.openai.sandbox_mode='workspace-write';
  await writeFile(path.join(dir,'definitions.json'),JSON.stringify(manifest));
  await assert.rejects(loadDefinitions({cwd:root,includeShared:false}),/requires read-only/);
});

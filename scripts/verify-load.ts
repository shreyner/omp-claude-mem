import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

const sdkDir = process.env.OMP_SDK_DIR ?? join(homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp/agent");
const hookPath = resolve(process.argv[2] ?? join(agentDir, "hooks/pre/claude-mem.ts"));
const { loadExtensions, bindPreparedExtensions } = await import(join(sdkDir, "src/extensibility/extensions/loader.ts"));
const expected = [
  "session_start", "session_switch", "session_branch", "session_compact", "before_agent_start",
  "tool_result", "agent_end", "context", "session_shutdown",
].sort();

const parent = await loadExtensions([hookPath], process.cwd());
const instances = [parent];
for (let index = 0; index < 2; index++) {
  instances.push(await bindPreparedExtensions(parent.preparedExtensions, process.cwd()));
}
for (const instance of instances) {
  assert.deepEqual(instance.errors, [], "OMP loader reported errors");
  assert.equal(instance.extensions.length, 1);
  assert.deepEqual([...instance.extensions[0].handlers.keys()].sort(), expected);
  for (const handlers of instance.extensions[0].handlers.values()) assert.equal(handlers.length, 1);
}
assert.notEqual(instances[0].extensions[0], instances[1].extensions[0]);
assert.notEqual(instances[1].extensions[0], instances[2].extensions[0]);
console.log(JSON.stringify({ hook: hookPath, instances: instances.length, handlers_per_instance: expected.length, events_emitted: 0 }));

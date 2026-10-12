// Deterministic policy/lifecycle tests for the actual embedded lease script.
// No desktop, Electron instance, network connection, or user files are used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../Sources/SkfiyKit/ElectronRendering.swift', import.meta.url), 'utf8');
const script = source.split('static let leaseScript = #"""')[1].split('"""#')[0];
function setup({ original = true, renders = true } = {}) {
  let now = 0;
  const timers = new Set();
  const set = (fn, ms, repeat) => { const t = { fn, due: now + ms, ms, repeat, unref() {} }; timers.add(t); return t; };
  const wc = { id: 7, destroyed: false, policy: original, changes: [],
    isDestroyed() { return this.destroyed; },
    getBackgroundThrottling() { return this.policy; },
    setBackgroundThrottling(value) { assert(!this.destroyed); this.changes.push(value); this.policy = value; },
    executeJavaScript() { return renders ? Promise.resolve(true) : new Promise(() => {}); } };
  const window = { webContents: wc, isDestroyed: () => wc.destroyed, isVisible: () => true,
    isMinimized: () => false, getMediaSourceId: () => 'window:88:0' };
  const context = vm.createContext({
    process: { pid: 41, execPath: '/fixture', getBuiltinModule: () => ({ createRequire: () => () => ({ BrowserWindow: { getAllWindows: () => [window] } }) }) },
    Date: { now: () => now }, setInterval: (fn, ms) => set(fn, ms, true), setTimeout: (fn, ms) => set(fn, ms, false),
    clearInterval: t => timers.delete(t), clearTimeout: t => timers.delete(t)
  });
  const lease = vm.runInContext('(' + script + ')', context);
  return { wc, window, lease: (owner = 'a', overrides = {}) => lease({ pid: 41, window: 88, owner, ...overrides }),
    tick(ms) { now += ms; for (const t of [...timers]) if (t.due <= now) { if (t.repeat) t.due = now + t.ms; else timers.delete(t); t.fn(); } },
    get timers() { return timers.size; } };
}
let tests = 0;
async function test(name, body) { await body(); tests++; console.log('ok', name); }
await test('last overlapping owner restores the original true policy', async () => {
  const s = setup(); assert.equal((await s.lease()).rendered, true); assert.equal(s.wc.policy, false);
  s.tick(10000); await s.lease('b'); s.tick(6000); assert.equal(s.wc.policy, false);
  s.tick(10000); assert.equal(s.wc.policy, true); assert.equal(s.timers, 0);
});
await test('same owner extends its expiry', async () => {
  const s = setup(); await s.lease(); s.tick(10000); await s.lease(); s.tick(6000);
  assert.equal(s.wc.policy, false); s.tick(10000); assert.equal(s.wc.policy, true);
});
await test('a pre-existing false policy stays false', async () => {
  const s = setup({ original: false }); await s.lease(); s.tick(16000); assert.equal(s.wc.policy, false);
});
await test('failed frame verification immediately restores policy', async () => {
  const s = setup({ renders: false }); const promise = s.lease(); s.tick(1300);
  assert.equal((await promise).rendered, false); assert.equal(s.wc.policy, true);
  s.tick(500); assert.equal(s.timers, 0);
});
await test('window and process mismatches never change a policy', async () => {
  const s = setup(); await s.lease('a', { window: 89 }); await s.lease('a', { pid: 42 });
  assert.deepEqual(s.wc.changes, []); assert.equal(s.timers, 0);
});
await test('hidden and minimized windows are left alone', async () => {
  const s = setup(); s.window.isVisible = () => false; await s.lease();
  s.window.isVisible = () => true; s.window.isMinimized = () => true; await s.lease();
  assert.deepEqual(s.wc.changes, []);
});
await test('closed windows remove their lease without calling a destroyed object', async () => {
  const s = setup(); await s.lease(); s.wc.destroyed = true; s.tick(16000); assert.equal(s.timers, 0);
});
await test('an app error during expiry cannot escape the cleanup timer', async () => {
  const s = setup(); await s.lease();
  s.wc.setBackgroundThrottling = () => { throw new Error('view closed during cleanup'); };
  assert.doesNotThrow(() => s.tick(16000)); assert.equal(s.timers, 0);
});
console.log(`PASS ${tests}/${tests} rendering lease tests`);

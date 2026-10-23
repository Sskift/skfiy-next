// Executes the production extension and injected page functions in isolated
// JavaScript worlds. No browser, desktop, network, or user profile is touched.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
const source = readFileSync(new URL('../browser-extension/background.js', import.meta.url), 'utf8');
const event = () => ({ addListener(fn) { this.listener = fn; } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup() {
  const clicks = [], effects = [], replies = [];
  const document = { activeElement: null, defaultView: null };
  class Element {
    constructor(tag, label = '') {
      Object.assign(this, { nodeType: 1, tagName: tag, innerText: label, textContent: label, children: [], childNodes: [],
        ownerDocument: document, parentElement: null, isConnected: true, scrollHeight: 100, clientHeight: 100, scrollTop: 0 });
    }
    getAttribute() { return null; }
    hasAttribute() { return false; }
    getRootNode() { return document; }
    matches() { return false; }
    querySelector() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20 }; }
    removeAttribute() {}
    scrollIntoView() {}
    closest() { return null; }
    dispatchEvent() { return true; }
    focus() { document.activeElement = this; }
    click() { clicks.push(this.innerText); }
  }
  const style = () => ({ visibility: 'visible', display: 'block', opacity: '1', overflowX: 'visible', overflowY: 'visible' });
  const window = { getComputedStyle: style }; window.top = window; document.defaultView = window;
  const body = new Element('BODY'); document.body = document.documentElement = document.scrollingElement = body;
  const approve = new Element('BUTTON', 'Approve'), remove = new Element('BUTTON', 'Delete');
  const setButtons = buttons => { body.children = body.childNodes = buttons; for (const el of buttons) el.parentElement = body; };
  setButtons([approve, remove]);
  const page = vm.createContext({ document, window, location: { href: 'https://fixture.invalid/' }, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    innerWidth: 800, innerHeight: 600, getComputedStyle: style, PointerEvent: class {}, MouseEvent: class {}, HTMLElement: Element });
  const nativePort = { onMessage: event(), onDisconnect: event(), postMessage: message => replies.push(message) };
  const tab = { id: 7, windowId: 1, status: 'complete', active: true, url: 'https://fixture.invalid/' };
  const stored = {};
  let scriptGate, actGate, captureGate;
  const chrome = {
    runtime: { connectNative: () => nativePort, getManifest: () => ({ version: 'test' }), onStartup: event(), onInstalled: event() },
    action: { setTitle() {}, setBadgeText() {}, setBadgeBackgroundColor() {} },
    storage: { session: { get: async key => ({ [key]: stored[key] }), set: async value => Object.assign(stored, value) } },
    tabs: { onRemoved: event(), get: async () => ({ ...tab }), remove: async () => effects.push('close'),
      update: async () => { effects.push('navigate'); return tab; } },
    webNavigation: { onCommitted: event() }, downloads: { onCreated: event() },
    windows: { get: async () => ({ state: 'normal' }), getAll: async () => [] },
    debugger: { attach: async () => { if (captureGate) await captureGate.promise; }, detach: async () => {},
      sendCommand: async (_target, method, params) => { if (method.startsWith('Input.')) effects.push([method, params]); return {}; } },
    scripting: { executeScript: async ({ func, args }) => {
      if (func.name === 'pageSnapshot' && scriptGate) await scriptGate.promise;
      if (func.name === 'pageAction' && actGate) await actGate.promise;
      const result = vm.runInContext('(' + func.toString() + ')', page)(...args);
      return [{ frameId: 0, result }];
    } }
  };
  const context = vm.createContext({ chrome, navigator: {}, crypto: { randomUUID }, URL, setTimeout: fn => { queueMicrotask(fn); }, console });
  vm.runInContext(source, context);
  const control = () => ({ cancelled: false, check() { if (this.cancelled) throw new Error('cancelled'); } });
  return { page, context, chrome, tab, clicks, effects, replies, approve, remove, setButtons, nativePort, control,
    state: (session = 'A') => context.dispatchRequest('state', { tab_id: 7, session_id: session }, control()),
    act: (state, params = {}, owner = control()) => context.dispatchRequest('act', { tab_id: 7, session_id: state.session_id,
      snapshot_id: state.snapshot_id, action: 'click', index: 0, ...params }, owner),
    gateSnapshot() { return scriptGate = deferred(); }, gateDebugger() { return captureGate = deferred(); },
    gateAction() { return actGate = deferred(); } };
}
let passed = 0;
async function test(name, body) { await body(); passed++; console.log('ok', name); }
await test('another session cannot reinterpret a previously observed index', async () => {
  const s = setup(); const a = await s.state('A');
  s.setButtons([s.remove, s.approve]); const b = await s.state('B');
  await assert.rejects(s.act(a), /snapshot expired|another session/);
  assert.deepEqual(s.clicks, []);
  await s.act(b, { index: 1 }); assert.deepEqual(s.clicks, ['Approve']);
});
await test('same-session refresh invalidates the old generation, including coordinates', async () => {
  const s = setup(); const old = await s.state(); await s.state();
  await assert.rejects(s.act(old, { index: null, x: 5, y: 5 }), /snapshot expired/);
  assert.deepEqual(s.clicks, []);
});
await test('injected action rechecks identity even after bridge validation', async () => {
  const s = setup(); const state = await s.state();
  const gate = s.gateAction(); const action = s.act(state);
  // Simulate a new document/isolated-world state after dispatch, before injection.
  s.page.__skfiy = undefined; gate.resolve();
  await assert.rejects(action, /page snapshot expired/);
  assert.deepEqual(s.clicks, []);
});
await test('DOM recycling still refuses a changed element within a valid snapshot', async () => {
  const s = setup(); const state = await s.state(); s.approve.innerText = 'Delete';
  await assert.rejects(s.act(state), /changed or was recycled/); assert.deepEqual(s.clicks, []);
});
await test('navigation invalidates both bridge and page bindings', async () => {
  const s = setup(); const state = await s.state();
  await s.chrome.webNavigation.onCommitted.listener({ tabId: 7 });
  await assert.rejects(s.act(state), /snapshot expired/);
  const next = await s.state(); s.page.location.href = 'https://another.invalid/';
  await assert.rejects(s.act(next), /page snapshot expired/);
});
await test('missing session protocol cannot fall back to unbound indices', async () => {
  const s = setup();
  await assert.rejects(s.context.dispatchRequest('state', { tab_id: 7 }, s.control()), /requires session-bound/);
  await assert.rejects(s.context.dispatchRequest('act', { tab_id: 7, action: 'click', index: 0 }, s.control()), /requires session-bound/);
});
await test('snapshots and actions for one tab are serialized', async () => {
  const s = setup(); const gate = s.gateSnapshot();
  const a = s.state('A'), b = s.state('B'); gate.resolve();
  const first = await a, last = await b;
  assert.notEqual(first.snapshot_id, last.snapshot_id);
  assert.equal(s.page.__skfiy.snapshot_id, last.snapshot_id);
});
await test('cancelled queued request sends no input and does not block the next request', async () => {
  const s = setup(); const state = await s.state();
  const gate = s.gateSnapshot(); const read = s.state();
  const owner = s.control(); const action = s.act(state, {}, owner); owner.cancelled = true;
  gate.resolve(); await read; await assert.rejects(action, /cancelled/);
  await s.state('B'); assert.deepEqual(s.clicks, []);
});
await test('native host cancellation withdraws an action waiting behind a snapshot', async () => {
  const s = setup(); const state = await s.state(); const gate = s.gateSnapshot();
  const reading = s.state();
  const action = s.nativePort.onMessage.listener({ id: 41, method: 'act', params: {
    tab_id: 7, session_id: state.session_id, snapshot_id: state.snapshot_id, action: 'click', index: 0 } });
  await s.nativePort.onMessage.listener({ method: 'cancel', params: { request_id: 41 } });
  gate.resolve(); await reading; await action;
  assert.deepEqual(s.clicks, []); assert(!s.replies.some(reply => reply.id === 41));
});
await test('cancellation during debugger attachment stops trusted input', async () => {
  const s = setup(); const state = await s.state(); const gate = s.gateDebugger();
  const owner = s.control(); const action = s.act(state, { trusted: true }, owner);
  await new Promise(resolve => setImmediate(resolve)); owner.cancelled = true; gate.resolve();
  await assert.rejects(action, /cancelled/); assert.deepEqual(s.effects, []);
});
console.log(`PASS ${passed}/${passed} browser session tests`);

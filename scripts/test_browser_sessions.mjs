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
  const listeners = {};
  const document = { activeElement: null, defaultView: null, addEventListener(name, fn) { listeners[name] = fn; } };
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
  class InputEvent {
    constructor(type, init) { this.type = type; Object.assign(this, init); this.defaultPrevented = false; }
    preventDefault() { this.defaultPrevented = true; }
  }
  const page = vm.createContext({ document, window, location: { href: 'https://fixture.invalid/' }, Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    innerWidth: 800, innerHeight: 600, getComputedStyle: style, PointerEvent: InputEvent, MouseEvent: InputEvent, HTMLElement: Element, crypto: { randomUUID },
    MutationObserver: class { observe() {} takeRecords() { return []; } } });
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
    webNavigation: { onCommitted: event(), onBeforeNavigate: event(), onErrorOccurred: event() }, downloads: { onCreated: event() },
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
  return { page, context, chrome, tab, clicks, effects, replies, approve, remove, setButtons, nativePort, control, listeners,
    state: (session = 'A') => context.dispatchRequest('state', { tab_id: 7, session_id: session }, control()),
    act: (state, params = {}, owner = control()) => context.dispatchRequest('act', { tab_id: 7, session_id: state.session_id,
      snapshot_id: state.snapshot_id, action: 'click', index: 0, ...params }, owner).then(result => { if (result.error) throw new Error(result.error); return result; }),
    gateSnapshot() { return scriptGate = deferred(); }, gateDebugger() { return captureGate = deferred(); },
    gateAction() { return actGate = deferred(); } };
}
let passed = 0;
async function test(name, body) { await body(); passed++; console.log('ok', name); }
await test('indexed and coordinate clicks select an option on their first attempt', async () => {
  for (const coordinates of [false, true]) {
    const s = setup(), state = await s.state();
    let moved = false, selected = 0;
    s.page.document.elementFromPoint = () => s.approve;
    s.approve.dispatchEvent = event => {
      if (event.type === 'pointermove') moved = true;
      // A popup guards the opening press until the pointer moves to an item.
      if (event.type === 'pointerup' && moved) selected++;
      if (event.type === 'pointerdown') assert.equal(event.buttons, 1);
      if (event.type === 'pointerup') assert.equal(event.buttons, 0);
      return true;
    };
    await s.act(state, coordinates ? { index: null, x: 30, y: 10 } : {});
    assert.equal(selected, 1);
  }
});
await test('cancelled pointer or mouse down preserves the popup focus', async () => {
  for (const cancelled of ['pointerdown', 'mousedown']) {
    for (const coordinates of [false, true]) {
      const s = setup(), state = await s.state(), events = [];
      s.page.document.activeElement = s.remove;
      s.page.document.elementFromPoint = () => s.approve;
      s.approve.dispatchEvent = event => { events.push(event.type); return event.type !== cancelled; };
      await s.act(state, coordinates ? { index: null, x: 30, y: 10 } : {});
      assert.equal(s.page.document.activeElement, s.remove);
      assert.equal(events.includes('mousedown'), cancelled !== 'pointerdown');
      assert.equal(events.includes('mouseup'), cancelled !== 'pointerdown');
    }
  }
});
await test('only finite closing popup animations need background rendering', async () => {
  const s = setup();
  s.page.document.hidden = true;
  s.page.document.querySelectorAll = () => [s.approve];
  let closed = false;
  s.approve.getAttribute = () => closed ? 'closed' : 'open';
  const style = { display: 'block', visibility: 'visible', animationName: 'exit', animationDuration: '.15s', animationDelay: '25ms', animationIterationCount: '1' };
  s.page.window.getComputedStyle = () => style;
  const duration = vm.runInContext('(' + s.context.backgroundClosingPopupAnimation.toString() + ')', s.page);
  assert.equal(duration(), 0); // An open menu must not be blurred by a debugger lease.
  closed = true; assert.equal(duration(), 175);
  style.animationIterationCount = 'infinite'; assert.equal(duration(), 0);
  style.animationIterationCount = '50'; assert.equal(duration(), 1000);
  s.page.document.hidden = false; assert.equal(duration(), 0);
});
await test('popup rendering failure preserves sent input without replaying it', async () => {
  const s = setup(), state = await s.state(), execute = s.chrome.scripting.executeScript;
  s.chrome.scripting.executeScript = options => options.func.name === 'backgroundClosingPopupAnimation'
    ? Promise.resolve([{ frameId: 0, result: 150 }]) : execute(options);
  s.chrome.debugger.attach = async () => { throw new Error('another debugger is attached'); };
  const receipt = await s.context.dispatchRequest('act', { tab_id: 7, session_id: state.session_id,
    snapshot_id: state.snapshot_id, action: 'click', index: 0 }, s.control());
  assert.equal(receipt.action_status, 'sent'); assert.match(receipt.error, /popup animation.*another debugger/);
  assert.deepEqual(s.clicks, ['Approve']);
});
await test('cancelled popup rendering releases its debugger without repeating input', async () => {
  const s = setup(), state = await s.state(), execute = s.chrome.scripting.executeScript;
  s.chrome.scripting.executeScript = options => options.func.name === 'backgroundClosingPopupAnimation'
    ? Promise.resolve([{ frameId: 0, result: 150 }]) : execute(options);
  const gate = s.gateDebugger(), owner = s.control();
  let detached = false;
  s.chrome.debugger.detach = async () => { detached = true; };
  const action = s.act(state, {}, owner);
  await new Promise(resolve => setImmediate(resolve)); owner.cancelled = true; gate.resolve();
  await assert.rejects(action, /cancelled/);
  assert(detached); assert.deepEqual(s.clicks, ['Approve']); assert.deepEqual(s.effects, []);
});
await test('snapshot recovers a temporarily unavailable frame without repeating navigation', async () => {
  const s = setup(), execute = s.chrome.scripting.executeScript;
  let attempts = 0;
  s.chrome.scripting.executeScript = async options => {
    if (options.func.name === 'pageSnapshot' && ++attempts < 3) throw new Error('Frame with ID 0 is not ready');
    return execute(options);
  };
  await s.context.dispatchRequest('open', { tab_id: 7, url: s.tab.url, session_id: 'A' }, s.control());
  const state = await s.state();
  assert.equal(attempts, 3); assert.deepEqual(s.effects, ['navigate']);
  await s.act(state); assert.deepEqual(s.clicks, ['Approve']);
});
await test('snapshot does not retry terminal errors or cancelled requests', async () => {
  for (const reason of ['Frame with ID 0 is showing error page', 'Cannot access a chrome:// URL', 'No tab with id: 7.']) {
    const s = setup(); let attempts = 0;
    s.chrome.scripting.executeScript = async () => { attempts++; throw new Error(reason); };
    await assert.rejects(s.state(), error => error.message.startsWith(reason)); assert.equal(attempts, 1);
  }
  const s = setup(), owner = s.control(); let attempts = 0;
  s.chrome.scripting.executeScript = async () => {
    attempts++; owner.cancelled = true; throw new Error('Frame with ID 0 is not ready');
  };
  await assert.rejects(s.context.dispatchRequest('state', { tab_id: 7, session_id: 'A' }, owner), /cancelled/);
  assert.equal(attempts, 1); assert.deepEqual(s.effects, []);
});
await test('snapshot recovery shares a bounded budget and never retries input', async () => {
  const s = setup(); let clock = 0, attempts = 0;
  s.context.Date = { now: () => clock };
  s.chrome.scripting.executeScript = async () => {
    attempts++; clock += 1000; throw new Error('Frame with ID 0 is not ready');
  };
  await assert.rejects(s.state(), /Frame with ID 0 is not ready/);
  assert.equal(attempts, 5); assert.deepEqual(s.clicks, []);
  const input = setup(), state = await input.state(), execute = input.chrome.scripting.executeScript;
  let inputs = 0;
  input.chrome.scripting.executeScript = async options => {
    if (options.func.name === 'pageAction') { inputs++; throw new Error('Frame with ID 0 is not ready'); }
    return execute(options);
  };
  await assert.rejects(input.act(state), /Frame with ID 0 is not ready/); assert.equal(inputs, 1);
});
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
  await s.chrome.webNavigation.onCommitted.listener({ tabId: 7, frameId: 0 });
  await assert.rejects(s.act(state), /snapshot expired/);
  const next = await s.state(); s.page.location.href = 'https://another.invalid/';
  await assert.rejects(s.act(next), /page snapshot expired/);
});
await test('a late subframe commit preserves the main button but expires screenshot coordinates', async () => {
  const s = setup(), state = await s.state();
  await s.chrome.webNavigation.onCommitted.listener({ tabId: 7, frameId: 3 });
  await s.act(state);
  assert.deepEqual(s.clicks, ['Approve']);
  await assert.rejects(s.act(state, { index: null, x: 5, y: 5, coordinate_geometry: state.geometry }), /frame|snapshot/);
  const fresh = await s.state();
  await assert.rejects(s.act(fresh, { index: null, x: 5, y: 5, coordinate_geometry: state.geometry }), /geometry|content changed/);
  assert.deepEqual(s.clicks, ['Approve']);
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
await test('trusted input refused before dispatch reports not_sent and keeps the page untouched', async () => {
  for (const action of ['click', 'key']) {
    for (const minimized of [false, true]) {
      const s = setup(), state = await s.state();
      s.tab.active = minimized;
      s.chrome.windows.get = async () => ({ state: minimized ? 'minimized' : 'normal' });
      s.chrome.debugger.attach = async () => { throw new Error('must not attach'); };
      s.approve.focus = () => { throw new Error('must not focus'); };
      s.approve.scrollIntoView = () => { throw new Error('must not scroll'); };
      const receipt = await s.context.dispatchRequest('act', { tab_id: 7, session_id: state.session_id,
        snapshot_id: state.snapshot_id, action, index: 0, key: 'Enter', trusted: true }, s.control());
      assert.equal(receipt.action_status, 'not_sent'); assert.match(receipt.error, /tab is in the background/);
      assert.deepEqual(s.effects, []); assert.deepEqual(s.clicks, []);
    }
  }
});
await test('coordinates expire after a resize, scroll or content change', async () => {
  for (const mutate of [s => { s.page.innerWidth = 900; }, s => { s.page.document.scrollingElement.scrollTop = 50; }, s => { s.page.__skfiyDocument.revision++; }]) {
    const s = setup(); const state = await s.state(); mutate(s);
    const receipt = await s.context.dispatchRequest('act', { tab_id: 7, session_id: state.session_id, snapshot_id: state.snapshot_id,
      action: 'click', x: 5, y: 5, coordinate_geometry: state.geometry }, s.control());
    assert.equal(receipt.action_status, 'not_sent'); assert.match(receipt.error, /geometry|content changed/); assert.deepEqual(s.clicks, []);
  }
});
await test('an acknowledged input is distinct from an uncertain injection', async () => {
  const s = setup(); const state = await s.state();
  const result = await s.act(state); assert.equal(result.action_status, 'sent');
  s.approve.click = () => { s.clicks.push('received then failed'); throw new Error('page callback failed'); };
  const receipt = await s.context.dispatchRequest('act', { tab_id: 7, session_id: state.session_id, snapshot_id: state.snapshot_id,
    action: 'click', index: 0 }, s.control());
  assert.equal(receipt.action_status, 'unknown'); assert.match(receipt.error, /callback failed/);
  assert.deepEqual(s.clicks, ['Approve', 'received then failed']);
});
await test('observation orders frames consistently and marks loading as unobservable', async () => {
  const s = setup(), state = await s.state();
  let reversed = false;
  s.chrome.scripting.executeScript = async () => {
    const frames = [{ frameId: 0, result: { text: 'Ready', url: s.tab.url } }, { frameId: 2, result: { text: 'Frame' } }];
    reversed = !reversed;
    return reversed ? frames.reverse() : frames;
  };
  const params = { tab_id: 7, session_id: state.session_id, snapshot_id: state.snapshot_id };
  const first = await s.context.dispatchRequest('observe', params, s.control());
  s.tab.status = 'loading';
  const second = await s.context.dispatchRequest('observe', params, s.control());
  assert.equal(first.treeText, second.treeText);
  assert.equal(first.loading, false); assert.equal(second.loading, true);
});
await test('changed observes checkbox state even when its text stays the same', async () => {
  const s = setup(), state = await s.state();
  s.approve.checked = false;
  s.page.document.querySelectorAll = () => [s.approve];
  const params = { tab_id: 7, session_id: state.session_id, snapshot_id: state.snapshot_id };
  const before = await s.context.dispatchRequest('observe', params, s.control());
  s.approve.checked = true;
  const after = await s.context.dispatchRequest('observe', params, s.control());
  assert.equal(before.text, after.text);
  assert.notEqual(before.treeText, after.treeText);
});
await test('target-only inspection preserves identity without surveying unrelated frames', async () => {
  const s = setup(), state = await s.state(), calls = [];
  const execute = s.chrome.scripting.executeScript;
  s.chrome.scripting.executeScript = async options => {
    calls.push(options.func.name);
    return execute(options);
  };
  const params = { tab_id: 7, session_id: state.session_id, snapshot_id: state.snapshot_id, index: 0, target_only: true, include_target: true };
  const observed = await s.context.dispatchRequest('observe', params, s.control());
  assert.ok(observed.identity); assert.equal(observed.label, 'Approve');
  assert.deepEqual(calls, ['pageAction']); assert.deepEqual(s.clicks, []);
  s.approve.isConnected = false;
  await assert.rejects(s.context.dispatchRequest('observe', params, s.control()), /gone/);
});
await test('inner scrolling invalidates coordinates even before the scroll event arrives', async () => {
  const s = setup();
  s.approve.scrollHeight = 300;
  s.page.document.elementFromPoint = () => s.approve.scrollTop ? s.remove : s.approve;
  const state = await s.state();
  s.approve.scrollTop = 100;
  await assert.rejects(s.act(state, { index: null, x: 5, y: 5, coordinate_geometry: state.geometry }), /geometry|content changed/);
  assert.deepEqual(s.clicks, []);
});
await test('capture scroll events invalidate a previously untracked container', async () => {
  const s = setup(), state = await s.state();
  s.listeners.scroll();
  await assert.rejects(s.act(state, { index: null, x: 5, y: 5, coordinate_geometry: state.geometry }), /geometry|content changed/);
});
await test('failed, incomplete and navigating probes never report absent text', async () => {
  for (const mode of ['failed', 'missing-top', 'frame-error', 'navigating', 'readable']) {
    const s = setup();
    s.chrome.scripting.executeScript = async () => {
      if (mode === 'failed') throw new Error('renderer unavailable');
      if (mode === 'missing-top') return [{ frameId: 2, result: { found: false, quietMs: 1000 } }];
      if (mode === 'navigating') s.tab.url += 'next';
      const frames = [{ frameId: 0, result: { found: false, quietMs: 1000 } }];
      if (mode === 'frame-error') frames.push({ frameId: 2, error: { message: 'unreadable' } });
      return frames;
    };
    const result = await s.context.dispatchRequest('probe', { tab_id: 7, session_id: 'A', text: 'Processing' }, s.control());
    assert.equal(result.found, mode === 'readable' ? false : null);
    assert.equal(result.loading, mode !== 'readable');
  }
});
await test('an error page reports only the network failure for this navigation', async () => {
  const s = setup();
  const failure = { tabId: 7, frameId: 0, url: s.tab.url, error: 'net::ERR_CONNECTION_REFUSED' };
  s.chrome.webNavigation.onErrorOccurred.listener(failure);
  s.chrome.scripting.executeScript = async () => { throw new Error('Frame with ID 0 is showing error page'); };
  const probe = () => s.context.dispatchRequest('probe', { tab_id: 7, session_id: 'A' }, s.control());
  assert.equal((await probe()).terminal, true);
  await assert.rejects(s.state(), /net::ERR_CONNECTION_REFUSED/);
  s.chrome.webNavigation.onBeforeNavigate.listener(failure);
  assert.doesNotMatch((await probe()).reason, /net::ERR_/);
  s.chrome.webNavigation.onErrorOccurred.listener({ ...failure, frameId: 2 });
  assert.doesNotMatch((await probe()).reason, /net::ERR_/);
});
await test('view-source immediately explains restricted page access without injecting', async () => {
  const s = setup(); s.tab.url = 'view-source:' + s.tab.url;
  let injections = 0;
  s.chrome.scripting.executeScript = async () => { injections++; return []; };
  await assert.rejects(s.state(), /view-source/);
  const result = await s.context.dispatchRequest('probe', { tab_id: 7, session_id: 'A' }, s.control());
  assert.equal(result.found, null); assert.equal(result.terminal, true); assert.equal(injections, 0);
});
await test('a pending destination never reads the old document or inherits its network error', async () => {
  const s = setup();
  let clock = 0;
  s.context.Date = { now: () => (clock += 250) };
  s.tab.url = 'about:blank';
  s.tab.pendingUrl = 'https://fixture.invalid/next';
  let injections = 0;
  s.chrome.scripting.executeScript = async () => { injections++; return []; };
  const probe = () => s.context.dispatchRequest('probe', { tab_id: 7, session_id: 'A' }, s.control());
  const failure = { tabId: 7, frameId: 0, url: s.tab.url, error: 'net::ERR_CONNECTION_RESET' };
  s.chrome.webNavigation.onErrorOccurred.listener(failure);
  const pending = await probe();
  assert.equal(pending.found, null); assert.ok(pending.loading && !pending.terminal);
  assert.match(pending.reason, /still navigating/);
  await assert.rejects(s.state(), /still navigating/);
  s.chrome.webNavigation.onErrorOccurred.listener({ ...failure, url: s.tab.pendingUrl });
  const failed = await probe();
  assert.equal(failed.terminal, true); assert.match(failed.reason, /net::ERR_CONNECTION_RESET/);
  await assert.rejects(s.state(), /net::ERR_CONNECTION_RESET/);
  assert.equal(injections, 0);
});
await test('a non-editable focused control refuses typing before any input', async () => {
  const s = setup(), state = await s.state();
  s.page.document.activeElement = s.approve;
  const result = await s.context.dispatchRequest('act', {
    tab_id: 7, session_id: state.session_id, snapshot_id: state.snapshot_id, action: 'type', text: 'fixture'
  }, s.control());
  assert.equal(result.action_status, 'not_sent'); assert.match(result.error, /editable text field/);
  assert.deepEqual(s.effects, []); assert.deepEqual(s.clicks, []);
});
await test('replacing a hidden file input after approval refuses the transfer', async () => {
  const s = setup();
  s.approve.getAttribute = name => name === 'aria-controls' ? 'upload' : null;
  const input = () => Object.assign(new s.approve.constructor('INPUT'), { type: 'file' });
  let receiver = input();
  s.page.document.getElementById = id => id === 'upload' ? receiver : null;
  const snapshot = await s.state();
  const binding = { tab_id: 7, session_id: snapshot.session_id, snapshot_id: snapshot.snapshot_id, index: 0 };
  const approved = await s.context.dispatchRequest('observe', { ...binding, upload_count: 1 }, s.control());
  assert.ok(approved.upload_token);
  const params = { ...binding, upload_token: approved.upload_token, token: 'file', action: 'upload-chunk', data: 'YQ==' };
  const staged = await s.context.dispatchRequest('act', params, s.control());
  assert.equal(staged.action_status, 'sent');
  // Replace only the receiver after the button and the snapshot both survived.
  receiver = input();
  const commit = await s.context.dispatchRequest('act', { ...params, action: 'upload-commit', files: [{ token: 'file', name: 'a' }] }, s.control());
  assert.equal(commit.action_status, 'not_sent'); assert.match(commit.error, /file input changed/);
  assert.equal(receiver.files, undefined);
});
await test('expired native request cannot dispatch input', async () => {
  const s = setup(), state = await s.state();
  await s.nativePort.onMessage.listener({ id: 99, method: 'act', params: { tab_id: 7, session_id: 'A',
    snapshot_id: state.snapshot_id, action: 'click', index: 0, deadline_at: Date.now() - 1 } });
  assert.deepEqual(s.clicks, []);
  assert.match(s.replies.find(r => r.id === 99).error, /timed out/);
});
console.log(`PASS ${passed}/${passed} browser session tests`);

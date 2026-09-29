// skfiy browser bridge: executes requests from the local skfiy server
// (relayed by the native messaging host) against tabs of this browser.
// Nothing here focuses a window or switches the user's active tab.

const HOST = 'com.skfiy.bridge';
const GROUP_TITLE = 'skfiy';
let port = null;

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (error) {
    port = null;
    showStatus(false);
    setTimeout(connect, 5000);
    return;
  }
  port.onMessage.addListener(async (message) => {
    let reply;
    try {
      reply = { id: message.id, result: await handle(message.method, message.params || {}) };
    } catch (error) {
      reply = { id: message.id, error: String((error && error.message) || error) };
    }
    if (port) port.postMessage(reply);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    // The host is missing or restarting; keep trying quietly.
    showStatus(false);
    setTimeout(connect, 5000);
  });
  port.postMessage({ event: 'hello', browser: browserName(), version: chrome.runtime.getManifest().version });
  showStatus(true);
}

// The toolbar icon shows whether the local skfiy host is reachable.
function showStatus(connected) {
  chrome.action.setTitle({
    title: connected ? 'skfiy: connected' : 'skfiy: not connected (run `skfiy install-browser-bridge`)'
  });
  chrome.action.setBadgeText({ text: connected ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#6B7280' });
}

function browserName() {
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const brand = brands.map((b) => b.brand).find((b) => !/Not.?A.?Brand|Chromium/i.test(b));
  return brand || 'Chromium';
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ------------------------------------------------------------ own tabs
// Tabs skfiy opened. Only these get dialog hooks: an alert there must not
// freeze the page the agent is working on, while the user's tabs stay as they are.

async function ownTabs() {
  const { ownTabs: ids = [] } = await chrome.storage.session.get('ownTabs');
  return new Set(ids);
}

async function markOwnTab(tabId) {
  const ids = await ownTabs();
  ids.add(tabId);
  await chrome.storage.session.set({ ownTabs: [...ids] });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const ids = await ownTabs();
  if (ids.delete(tabId)) await chrome.storage.session.set({ ownTabs: [...ids] });
});

chrome.webNavigation.onCommitted.addListener(async ({ tabId }) => {
  if ((await ownTabs()).has(tabId)) await hookDialogs(tabId);
});

async function hookDialogs(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, world: 'MAIN', injectImmediately: true, func: installDialogHooks
  }).catch(() => {});
}

// ---------------------------------------------------------------- requests

async function handle(method, params) {
  switch (method) {
    case 'tabs': return listTabs();
    case 'open': return openTab(params);
    case 'navigate': return navigate(params);
    case 'close': return closeTab(params);
    case 'state': return tabState(params);
    case 'screenshot': return screenshot(params);
    case 'act': return act(params);
    case 'probe': return probe(params);
    default: throw new Error(`unknown method ${method}`);
  }
}

async function listTabs() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const focused = windows.find((w) => w.focused);
  return windows.map((w) => ({
    windowId: w.id,
    focused: w.focused,
    minimized: w.state === 'minimized',
    tabs: w.tabs.map((t) => ({
      id: t.id, title: t.title, url: t.url, active: t.active, groupId: t.groupId,
      loading: t.status === 'loading', userVisible: t.active && w.id === (focused && focused.id)
    }))
  }));
}

async function tabById(tabId) {
  if (tabId == null) throw new Error('tab_id is required (see browser_tabs)');
  try {
    return await chrome.tabs.get(Number(tabId));
  } catch {
    throw new Error(`no tab ${tabId}; call browser_tabs`);
  }
}

async function skfiyGroup(windowId) {
  const groups = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
  return groups.length ? groups[0].id : null;
}

async function openTab({ url, tab_id: tabId }) {
  if (!url) throw new Error('url is required');
  if (tabId != null) {
    const tab = await chrome.tabs.update(Number(tabId), { url });
    await waitForLoad(tab.id);
    return { tabId: tab.id };
  }
  // A background tab in the user's last window, gathered in a "skfiy" group.
  const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false, ...(window ? { windowId: window.id } : {}) });
  await markOwnTab(tab.id);
  await chrome.tabs.update(tab.id, { url });
  try {
    const existing = await skfiyGroup(tab.windowId);
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(existing != null ? { groupId: existing } : {}) });
    if (existing == null) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'grey' });
  } catch {
    // Tab groups are cosmetic.
  }
  await waitForLoad(tab.id);
  return { tabId: tab.id };
}

async function navigate({ tab_id: tabId, action }) {
  const tab = await tabById(tabId);
  if (action === 'back') await chrome.tabs.goBack(tab.id);
  else if (action === 'forward') await chrome.tabs.goForward(tab.id);
  else if (action === 'reload') await chrome.tabs.reload(tab.id);
  else throw new Error('action must be back, forward, or reload');
  await delay(300);
  await waitForLoad(tab.id);
  return { tabId: tab.id };
}

async function closeTab({ tab_id: tabId }) {
  const tab = await tabById(tabId);
  await chrome.tabs.remove(tab.id);
  return { closed: tab.id };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLoad(tabId, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === 'complete') return;
    await delay(150);
  }
}

async function run(tabId, func, args, frameId = 0) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func, args, world: 'ISOLATED' });
  if (!result) throw new Error('the page did not answer');
  return result.result;
}

// Element indices across frames: index -> { frameId, local }, per tab. The
// top frame reads same-origin frames itself; cross-origin frames report
// their own elements, which are numbered after the page's.
const frameIndex = new Map();

async function tabState({ tab_id: tabId, max_chars: maxChars }) {
  const tab = await tabById(tabId);
  await waitForLoad(tab.id, 5000);
  const frames = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true }, func: pageSnapshot, args: [maxChars || 30000], world: 'ISOLATED'
  });
  const top = frames.find((f) => f.frameId === 0);
  if (!top || !top.result) throw new Error('the page did not answer');
  const map = [];
  const lines = [];
  const dialogs = [];
  let truncated = false;
  for (const { frameId, result } of [top, ...frames.filter((f) => f.frameId !== 0)]) {
    if (!result || !result.ownFrame) continue;
    const base = map.length;
    if (frameId !== 0) lines.push(`--- frame ${result.url} ---`);
    for (const line of result.lines) lines.push(line.replace(/^\[(\d+)\]/, (_, n) => `[${Number(n) + base}]`));
    for (let local = 0; local < result.count; local++) map.push({ frameId, local });
    dialogs.push(...result.dialogs);
    truncated = truncated || result.truncated;
  }
  frameIndex.set(tab.id, map);
  const notes = dialogs.map((d) => d.type === 'alert'
    ? `(page dialog) alert ${JSON.stringify(d.message)}, dismissed`
    : `(page dialog) ${d.type} ${JSON.stringify(d.message)}, answered ${JSON.stringify(d.answer)}`);
  return { tabId: tab.id, title: tab.title, url: tab.url, active: tab.active, ...top.result, lines: [...notes, ...lines], truncated };
}

/// The frame and frame-local index of a page element index.
function locateIndex(tabId, index) {
  if (index == null) return { frameId: 0, local: null };
  const map = frameIndex.get(tabId);
  if (!map) return { frameId: 0, local: index };
  const entry = map[Number(index)];
  if (!entry) throw new Error(`no element ${index}; call browser_state again`);
  return entry;
}

async function screenshot({ tab_id: tabId, background }) {
  const tab = await tabById(tabId);
  const window = await chrome.windows.get(tab.windowId);
  if (tab.active && window.state !== 'minimized') {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    return { jpeg: dataUrl.replace(/^data:image\/jpeg;base64,/, '') };
  }
  if (!background) {
    return { unavailable: 'Only the tab shown in its window can be captured without Chrome\'s debugger, and skfiy does not switch the user\'s tabs.' };
  }
  // A hidden tab still renders for the debugger's capture.
  const shot = await withDebugger(tab.id, (send) => send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }));
  return { jpeg: shot.data, debugger: true };
}

// For browser_wait: whether a text is shown in any frame, and how long the
// page has gone without DOM changes.
async function probe({ tab_id: tabId, text }) {
  const tab = await tabById(tabId);
  const frames = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true }, func: pageProbe, args: [String(text || '').toLowerCase()], world: 'ISOLATED'
  }).catch(() => []);
  const answers = frames.map((f) => f.result).filter(Boolean);
  return {
    loading: tab.status !== 'complete' || !answers.length,
    found: answers.some((a) => a.found),
    quietMs: answers.length ? Math.min(...answers.map((a) => a.quietMs)) : 0
  };
}

function pageProbe(text) {
  const quiet = (globalThis.__skfiyQuiet = globalThis.__skfiyQuiet || { last: Date.now() });
  if (!quiet.observer && document.documentElement) {
    quiet.observer = new MutationObserver(() => { quiet.last = Date.now(); });
    quiet.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }
  let found = false;
  if (text) {
    const fields = Array.from(document.querySelectorAll('input:not([type=password]), textarea')).map((el) => el.value);
    const content = [document.title, (document.body && document.body.innerText) || '', ...fields].join('\n');
    found = content.toLowerCase().includes(text);
  }
  return { found, quietMs: Date.now() - quiet.last };
}

async function act(params) {
  const tab = await tabById(params.tab_id);
  const { frameId, local } = locateIndex(tab.id, params.index);
  if ((await ownTabs()).has(tab.id)) await hookDialogs(tab.id);
  if (params.trusted && frameId !== 0) throw new Error('trusted input only reaches the page itself, not elements inside a frame; use the default events');
  const inFrame = { ...params, index: local };
  if (params.action === 'hover') inFrame.css = await foreignStyles(tab.id, frameId);
  const result = params.trusted ? await trustedAct(tab.id, params) : await run(tab.id, pageAction, [inFrame], frameId);
  if (result && result.openInBackground) {
    await openTab({ url: result.openInBackground });
    result.message += ' (opened in a new background tab in the "skfiy" group)';
  }
  await delay(250);
  await waitForLoad(tab.id, 8000);
  return result;
}

// :hover rules in stylesheets from other origins, which the page may not read;
// host permissions let the extension fetch them.
const cssCache = new Map();

async function foreignStyles(tabId, frameId) {
  const hrefs = await run(tabId, unreadableSheets, [], frameId).catch(() => []);
  const texts = [];
  for (const href of (hrefs || []).slice(0, 20)) {
    if (!cssCache.has(href)) {
      const text = await fetch(href, { credentials: 'omit' }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
      cssCache.set(href, text.length < 3000000 ? text : '');
    }
    if (cssCache.get(href)) texts.push(cssCache.get(href));
  }
  return texts;
}

function unreadableSheets() {
  const hrefs = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try { void sheet.cssRules; } catch { if (sheet.href) hrefs.push(sheet.href); }
  }
  return hrefs;
}

// Real input events through Chrome's debugger, for pages that ignore
// synthetic ones. Chrome shows its "is debugging this browser" bar while
// attached, so it is attached only for the one action.
async function withDebugger(tabId, body) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try {
    const send = (method, commandParams) => chrome.debugger.sendCommand(target, method, commandParams);
    // A background tab has no input focus; emulate it so key and mouse events land.
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    return await body(send);
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

const CDP_KEYS = {
  Enter: [13, '\r'], Tab: [9, ''], Backspace: [8, ''], Delete: [46, ''], Escape: [27, ''], ' ': [32, ' '],
  ArrowLeft: [37, ''], ArrowUp: [38, ''], ArrowRight: [39, ''], ArrowDown: [40, ''],
  PageUp: [33, ''], PageDown: [34, ''], Home: [36, ''], End: [35, '']
};

async function cdpKey(send, combo) {
  const parts = String(combo).split('+');
  const raw = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const modifiers = (mods.has('alt') || mods.has('option') ? 1 : 0) | (mods.has('ctrl') || mods.has('control') ? 2 : 0)
    | (mods.has('cmd') || mods.has('command') || mods.has('super') || mods.has('meta') ? 4 : 0) | (mods.has('shift') ? 8 : 0);
  const aliases = { return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace',
    delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', space: ' ',
    page_up: 'PageUp', page_down: 'PageDown', home: 'Home', end: 'End' };
  const key = aliases[raw.toLowerCase()] || raw;
  const [code, named] = CDP_KEYS[key] || [key.toUpperCase().charCodeAt(0), key];
  const text = modifiers & 6 ? '' : named;
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, windowsVirtualKeyCode: code, modifiers, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code, modifiers });
}

async function trustedAct(tabId, params) {
  const tab = await chrome.tabs.get(tabId);
  const window = await chrome.windows.get(tab.windowId);
  if ((params.action === 'click' || params.action === 'key') && (!tab.active || window.state === 'minimized')) {
    // Chrome drops debugger mouse and key events for hidden tabs.
    throw new Error('trusted clicks and keys only reach the tab shown in its window, and this tab is in the background. Use the default events (trusted: false); trusted typing works in any tab.');
  }
  if (params.action === 'click') {
    const point = params.index == null
      ? { x: Number(params.x), y: Number(params.y) }
      : await run(tabId, pageAction, [{ ...params, action: 'locate' }]);
    await withDebugger(tabId, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    });
    return { message: `Clicked ${params.index == null ? `at (${Math.round(point.x)}, ${Math.round(point.y)})` : `[${params.index}]`} with real input events` };
  }
  if (params.action === 'type') {
    await run(tabId, pageAction, [{ ...params, action: 'focus' }]);
    await withDebugger(tabId, async (send) => {
      await send('Input.insertText', { text: String(params.text || '') });
      if (params.submit) await cdpKey(send, 'Enter');
    });
    return { message: `Typed ${String(params.text || '').length} character(s) with real input events${params.submit ? ' and submitted' : ''}` };
  }
  if (params.action === 'key') {
    if (params.index != null) await run(tabId, pageAction, [{ ...params, action: 'focus', keep: true }]);
    await withDebugger(tabId, (send) => cdpKey(send, params.key));
    return { message: `Pressed ${params.key} with real input events` };
  }
  return run(tabId, pageAction, [params]);
}

// ------------------------------------------------ injected page functions
// Both run in the extension's isolated world of the page. They must be
// self-contained: executeScript serializes only the function body.

function pageSnapshot(maxChars) {
  const state = (globalThis.__skfiy = globalThis.__skfiy || { elements: [] });
  state.elements = [];
  const lines = [];
  let chars = 0;
  let truncated = false;
  let text = '';

  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'switch', 'textbox', 'combobox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL|TD|TH|BR|LABEL)$/;

  const push = (line) => {
    if (truncated) return;
    if (chars + line.length > maxChars) { truncated = true; return; }
    lines.push(line);
    chars += line.length + 1;
  };
  const flush = () => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean) push(clean);
    text = '';
  };
  const clip = (value, n) => {
    const v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return v.length > n ? v.slice(0, n) + '…' : v;
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const interactive = (el) => {
    const tag = el.tagName;
    if (tag === 'A' && el.hasAttribute('href')) return true;
    if (['BUTTON', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(tag)) return true;
    if (tag === 'INPUT') return el.type !== 'hidden';
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    const tabindex = el.getAttribute('tabindex');
    return tabindex !== null && Number(tabindex) >= 0 && tag !== 'BODY';
  };
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.innerText).join(' ');
      if (text.trim()) return text;
    }
    if (el.labels && el.labels.length) {
      // A label wrapping its control would otherwise swallow the control's text (e.g. every option).
      const text = Array.from(el.labels).map((label) => Array.from(label.childNodes)
        .filter((n) => !(n.nodeType === 1 && (n === el || n.contains(el) || ['SELECT', 'INPUT', 'TEXTAREA', 'BUTTON'].includes(n.tagName))))
        .map((n) => n.textContent).join(' ')).join(' ');
      if (text.trim()) return text;
    }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) return el.value;
    if (el.tagName === 'IMG') return el.alt;
    const inner = el.innerText;
    if (inner && inner.trim()) return inner;
    return el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
  };
  const describe = (el, index) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    let kind = role || (tag === 'input' ? (el.type || 'text') : tag === 'a' ? 'link' : tag);
    if (el.isContentEditable && tag !== 'input' && tag !== 'textarea') kind = 'editable';
    const parts = [`[${index}] ${kind}`];
    const label = clip(labelOf(el), 100);
    if (label) parts.push(JSON.stringify(label));
    if (tag === 'input' || tag === 'textarea') {
      if (['checkbox', 'radio'].includes(el.type)) parts.push(el.checked ? 'checked' : 'unchecked');
      else if (el.type !== 'password') parts.push(`value=${JSON.stringify(clip(el.value, 200))}`);
      else if (el.value) parts.push('value=(hidden)');
      if (el.placeholder && !el.value) parts.push(`placeholder=${JSON.stringify(clip(el.placeholder, 60))}`);
    } else if (tag === 'select') {
      parts.push(`value=${JSON.stringify(clip(el.selectedOptions[0] ? el.selectedOptions[0].text : '', 60))}`);
      parts.push(`options=[${Array.from(el.options).slice(0, 30).map((o) => JSON.stringify(clip(o.text, 30))).join(', ')}]`);
    } else if (kind === 'editable') {
      parts.push(`value=${JSON.stringify(clip(el.innerText, 200))}`);
    } else if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) parts.push(`href=${JSON.stringify(clip(href, 80))}`);
      if (el.target === '_blank') parts.push('new-tab');
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    if (el.getAttribute('aria-expanded')) parts.push(`expanded=${el.getAttribute('aria-expanded')}`);
    if (el.getAttribute('aria-checked') && !['INPUT'].includes(el.tagName)) parts.push(`checked=${el.getAttribute('aria-checked')}`);
    if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
    if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
      parts.push(`scroll=${Math.round(el.scrollTop)}/${el.scrollHeight - el.clientHeight}`);
    }
    if (document.activeElement === el) parts.push('focused');
    return parts.join(' ');
  };

  const walk = (node) => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD'].includes(tag)) return;
    if (!visible(el) && el.children.length === 0) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (interactive(el) && visible(el)) {
      flush();
      const index = state.elements.length;
      state.elements.push(el);
      push(describe(el, index));
      if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      // Nested controls (a button inside a link) still get their own index.
      for (const child of el.children) {
        if (child.querySelector && (interactive(child) || child.querySelector('a[href],button,input,select,textarea,[role=button],[role=link]'))) walk(child);
      }
      return;
    }
    const block = BLOCK.test(tag);
    if (block) flush();
    if (/^H[1-6]$/.test(tag)) {
      flush();
      text = '#'.repeat(Number(tag[1])) + ' ';
    }
    if (tag === 'IMG' && el.alt && visible(el)) text += ` [image: ${clip(el.alt, 60)}] `;
    for (const child of el.childNodes) walk(child);
    if (el.shadowRoot) for (const child of el.shadowRoot.childNodes) walk(child);
    if (tag === 'IFRAME') {
      try {
        if (el.contentDocument && el.contentDocument.body) walk(el.contentDocument.body);
      } catch { /* cross-origin frame */ }
    }
    if (block) flush();
  };
  walk(document.body || document.documentElement);
  flush();

  const scroller = document.scrollingElement || document.documentElement;
  const maxScroll = Math.max(0, scroller.scrollHeight - innerHeight);
  // Report this frame on its own unless its parent (same origin) read it already.
  let ownFrame = window === window.top;
  if (!ownFrame) {
    try { ownFrame = !window.parent.document; } catch { ownFrame = true; }
  }
  const root = document.documentElement;
  const dialogs = JSON.parse((root && root.getAttribute('data-skfiy-dialogs')) || '[]');
  if (root) root.removeAttribute('data-skfiy-dialogs');
  return {
    count: state.elements.length,
    ownFrame,
    url: location.href,
    dialogs,
    lines,
    truncated,
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { y: Math.round(scroller.scrollTop), max: Math.round(maxScroll) },
    focused: document.activeElement && document.activeElement !== document.body
      ? state.elements.indexOf(document.activeElement) : -1
  };
}

function pageAction(params) {
  const state = globalThis.__skfiy || { elements: [] };
  const { action } = params;
  // How the page's next confirm() or prompt() is answered (see installDialogHooks).
  if (params.dialog) {
    document.documentElement.setAttribute('data-skfiy-dialog-answer',
      JSON.stringify({ accept: params.dialog !== 'dismiss', text: params.prompt_text }));
  }
  const pick = () => {
    if (params.index == null) return null;
    const el = state.elements[Number(params.index)];
    if (!el || !el.isConnected) throw new Error(`element ${params.index} is gone; call browser_state again`);
    return el;
  };
  const center = (el) => {
    const rect = el.getBoundingClientRect();
    return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  };
  const pointer = (el, type, extra) => {
    const init = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, ...center(el), ...extra };
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    return el.dispatchEvent(new Ctor(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, ...init }));
  };
  const editable = (el) => el && (el.isContentEditable || el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'].includes(el.type)));
  const setNativeValue = (el, value) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const insertText = (el, text) => {
    el.focus();
    // execCommand keeps undo history and fires trusted beforeinput/input events,
    // which frameworks such as React rely on.
    const before = el.isContentEditable ? el.innerText : el.value;
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
    const after = el.isContentEditable ? el.innerText : el.value;
    if (!ok || after === before) {
      if (el.isContentEditable) {
        const selection = getSelection();
        if (!selection.rangeCount || !el.contains(selection.anchorNode)) {
          selection.selectAllChildren(el);
          selection.collapseToEnd();
        }
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } else {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        setNativeValue(el, el.value.slice(0, start) + text + el.value.slice(end));
        try { el.setSelectionRange(start + text.length, start + text.length); } catch { /* not a text input */ }
      }
    }
  };
  const key = (el, name, init) => {
    const target = el || document.activeElement || document.body;
    const opts = { key: name, bubbles: true, cancelable: true, composed: true, ...init };
    const proceed = target.dispatchEvent(new KeyboardEvent('keydown', opts));
    if (proceed && name.length === 1) target.dispatchEvent(new KeyboardEvent('keypress', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
    return { target, proceed };
  };

  // Script cannot put an element in the :hover state, so the page's :hover
  // rules are copied onto an attribute that marks the hovered chain.
  const applyHoverStyles = (foreign) => {
    const rules = [];
    const convert = (list) => {
      for (const rule of Array.from(list || [])) {
        if (rule.selectorText !== undefined && rule.style) {
          if (rule.selectorText.includes(':hover')) {
            rules.push(`${rule.selectorText.replace(/:hover\b/g, '[data-skfiy-hover]')} { ${rule.style.cssText} }`);
          }
        } else if (rule.media) {
          if (matchMedia(rule.media.mediaText).matches) convert(rule.cssRules);
        } else if (rule.cssRules) {
          convert(rule.cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      if (sheet.ownerNode && sheet.ownerNode.id === 'skfiy-hover-style') continue;
      try { convert(sheet.cssRules); } catch { /* another origin: among `foreign` */ }
    }
    for (const text of foreign) {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(text);
        convert(sheet.cssRules);
      } catch { /* not parsable */ }
    }
    let style = document.getElementById('skfiy-hover-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'skfiy-hover-style';
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = rules.join('\n');
  };

  switch (action) {
    case 'hover': {
      const el = params.index != null ? pick() : document.elementFromPoint(Number(params.x), Number(params.y));
      if (!el) throw new Error(params.index != null || params.x == null ? 'index (or x and y) is required' : 'nothing at that point of the viewport');
      if (params.index != null) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const at = params.index != null ? center(el) : { clientX: Number(params.x), clientY: Number(params.y) };
      // The element and its ancestors, across shadow roots.
      const chain = (node) => {
        const list = [];
        for (let n = node; n; n = n.parentElement || (n.parentNode && n.parentNode.host) || null) list.push(n);
        return list;
      };
      const fire = (target, type, bubbles) => target.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type,
        { bubbles, cancelable: true, composed: true, view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...at }));
      const before = state.hovered && state.hovered.isConnected ? state.hovered : null;
      const left = before ? chain(before) : [];
      const entered = chain(el);
      if (before && before !== el) {
        fire(before, 'pointerout', true); fire(before, 'mouseout', true);
        for (const n of left.filter((n) => !entered.includes(n))) { fire(n, 'pointerleave', false); fire(n, 'mouseleave', false); }
      }
      if (before !== el) {
        fire(el, 'pointerover', true); fire(el, 'mouseover', true);
        for (const n of entered.filter((n) => !left.includes(n)).reverse()) { fire(n, 'pointerenter', false); fire(n, 'mouseenter', false); }
      }
      fire(el, 'pointermove', true); fire(el, 'mousemove', true);
      for (const n of Array.from(document.querySelectorAll('[data-skfiy-hover]'))) n.removeAttribute('data-skfiy-hover');
      for (const n of entered) n.setAttribute('data-skfiy-hover', '');
      applyHoverStyles(params.css || []);
      state.hovered = el;
      return { message: params.index != null ? `Hovered [${params.index}]` : `Hovered at (${Math.round(at.clientX)}, ${Math.round(at.clientY)}) on <${el.tagName.toLowerCase()}>` };
    }
    case 'locate': {
      const el = pick();
      if (!el) throw new Error('index (or x and y) is required');
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return center(el).clientX !== undefined ? { x: center(el).clientX, y: center(el).clientY } : null;
    }
    case 'focus': {
      const el = pick() || document.activeElement;
      if (!el) throw new Error('nothing to focus');
      el.focus();
      if (params.keep) return { message: 'focused' };
      if (params.clear) {
        if (el.isContentEditable) getSelection().selectAllChildren(el); else if (el.select) el.select();
      } else if (el.isContentEditable) {
        getSelection().selectAllChildren(el); getSelection().collapseToEnd();
      } else {
        try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not a text input */ }
      }
      return { message: 'focused' };
    }
    case 'click': {
      if (params.index == null && params.x != null && params.y != null) {
        // Coordinates in CSS pixels of the viewport (canvas, maps, custom widgets).
        const target = document.elementFromPoint(Number(params.x), Number(params.y));
        if (!target) throw new Error('nothing at that point of the viewport');
        const at = { clientX: Number(params.x), clientY: Number(params.y) };
        for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown']) {
          target.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, view: window, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...at }));
        }
        if (typeof target.focus === 'function') target.focus({ preventScroll: true });
        for (const type of ['pointerup', 'mouseup', 'click']) {
          target.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, view: window, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...at }));
        }
        return { message: `Clicked at (${Math.round(at.clientX)}, ${Math.round(at.clientY)}) on <${target.tagName.toLowerCase()}>` };
      }
      const el = pick();
      if (!el) throw new Error('index (or x and y) is required');
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const anchor = el.closest('a[href]');
      if (anchor && anchor.target === '_blank' && !anchor.getAttribute('href').startsWith('javascript:')) {
        // A synthetic click cannot open a popup; open the link as a background tab instead.
        return { message: `Link to ${anchor.href}`, openInBackground: anchor.href };
      }
      pointer(el, 'pointerover'); pointer(el, 'mouseover');
      pointer(el, 'pointerdown'); pointer(el, 'mousedown');
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
      pointer(el, 'pointerup'); pointer(el, 'mouseup');
      if (typeof el.click === 'function') el.click(); else pointer(el, 'click');
      return { message: `Clicked [${params.index}]` };
    }
    case 'type': {
      const el = pick() || document.activeElement;
      if (!editable(el)) throw new Error('the target is not a text field; pass the index of an input, textarea, or editable element');
      if (params.clear) {
        el.focus();
        if (el.isContentEditable) {
          getSelection().selectAllChildren(el);
          document.execCommand('delete');
        } else {
          el.select();
          if (!document.execCommand('delete') || el.value) setNativeValue(el, '');
        }
      } else if (params.index != null && document.activeElement !== el) {
        el.focus();
        // Typing into a field by index appends, like clicking at its end.
        if (el.isContentEditable) { getSelection().selectAllChildren(el); getSelection().collapseToEnd(); }
        else { try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* ignore */ } }
      }
      insertText(el, params.text || '');
      if (params.submit) {
        const { proceed } = key(el, 'Enter', { code: 'Enter', keyCode: 13 });
        if (proceed && el.form) el.form.requestSubmit();
      }
      return { message: `Typed ${String(params.text || '').length} character(s)${params.submit ? ' and submitted' : ''}` };
    }
    case 'select': {
      const el = pick();
      if (!el || el.tagName !== 'SELECT') throw new Error('index must point at a select element');
      const wanted = String(params.option || '').trim().toLowerCase();
      const option = Array.from(el.options).find((o) => o.text.trim().toLowerCase() === wanted || o.value.toLowerCase() === wanted)
        || Array.from(el.options).find((o) => o.text.trim().toLowerCase().includes(wanted));
      if (!option) throw new Error(`no option matches "${params.option}"; options: ${Array.from(el.options).map((o) => o.text).join(', ')}`);
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { message: `Selected "${option.text}"` };
    }
    case 'key': {
      const el = pick();
      if (el) el.focus();
      const target = el || document.activeElement || document.body;
      const combo = String(params.key || '');
      const parts = combo.split('+');
      const name = parts.pop();
      const mods = new Set(parts.map((p) => p.toLowerCase()));
      const init = {
        metaKey: mods.has('cmd') || mods.has('command') || mods.has('super') || mods.has('meta'),
        ctrlKey: mods.has('ctrl') || mods.has('control'),
        altKey: mods.has('alt') || mods.has('option'),
        shiftKey: mods.has('shift')
      };
      const aliases = { return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace',
        delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', space: ' ',
        page_up: 'PageUp', page_down: 'PageDown', home: 'Home', end: 'End' };
      const keyName = aliases[name.toLowerCase()] || name;
      const { proceed } = key(target, keyName, { ...init, code: keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName });
      // Default actions that synthetic key events do not perform by themselves.
      if (proceed && !init.metaKey && !init.ctrlKey) {
        if (keyName === 'Enter') {
          if (target.tagName === 'TEXTAREA' || target.isContentEditable) insertText(target, '\n');
          else if (target.form) target.form.requestSubmit();
          else if (typeof target.click === 'function' && ['A', 'BUTTON'].includes(target.tagName)) target.click();
        } else if (keyName === 'Backspace' && editable(target)) {
          document.execCommand('delete');
        } else if (keyName === 'Delete' && editable(target)) {
          document.execCommand('forwardDelete');
        } else if (keyName === 'Tab') {
          const focusable = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]'))
            .filter((n) => !n.disabled && n.getClientRects().length);
          const at = focusable.indexOf(target);
          const next = focusable[(at + (init.shiftKey ? -1 : 1) + focusable.length) % focusable.length];
          if (next) next.focus();
        } else if (keyName.length === 1 && editable(target)) {
          insertText(target, keyName);
        } else if (['PageDown', 'PageUp', 'Home', 'End', ' '].includes(keyName) && !editable(target)) {
          const page = innerHeight * 0.85;
          const top = { PageDown: page, ' ': page, PageUp: -page, Home: -1e9, End: 1e9 }[keyName];
          (document.scrollingElement || document.documentElement).scrollBy({ top, behavior: 'instant' });
        }
      } else if (proceed && (init.metaKey || init.ctrlKey) && keyName.toLowerCase() === 'a' && editable(target)) {
        if (target.isContentEditable) getSelection().selectAllChildren(target); else target.select();
      }
      return { message: `Pressed ${combo}` };
    }
    case 'scroll': {
      const el = pick();
      const scroller = el || document.scrollingElement || document.documentElement;
      const vertical = params.direction === 'up' || params.direction === 'down';
      const size = vertical ? (el ? el.clientHeight : innerHeight) : (el ? el.clientWidth : innerWidth);
      const sign = params.direction === 'up' || params.direction === 'left' ? -1 : 1;
      const distance = sign * size * 0.85 * (Number(params.pages) || 1);
      scroller.scrollBy({ top: vertical ? distance : 0, left: vertical ? 0 : distance, behavior: 'instant' });
      return { message: `Scrolled ${params.direction}` };
    }
    case 'upload-chunk': {
      // Files arrive in base64 pieces, since native messages are size-limited.
      state.uploads = state.uploads || {};
      state.uploads[params.token] = (state.uploads[params.token] || '') + params.data;
      return { message: `received ${state.uploads[params.token].length} characters` };
    }
    case 'upload-commit': {
      const el = pick();
      if (!el || el.tagName !== 'INPUT' || el.type !== 'file') throw new Error(`element ${params.index} is not a file input`);
      const encoded = (state.uploads || {})[params.token] || '';
      delete state.uploads[params.token];
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], params.name, { type: params.mime || 'application/octet-stream' }));
      el.files = transfer.files;
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { message: `Attached ${params.name} (${bytes.length} bytes) to [${params.index}]` };
    }
    default:
      throw new Error(`unknown action ${action}`);
  }
}

// Runs in the page's own world of the agent's tabs: alert, confirm and prompt
// would block the page until someone clicks, so they answer at once and leave
// a note for browser_state. Answers default to OK and the default text.
function installDialogHooks() {
  if (window.__skfiyDialogHooks) return;
  window.__skfiyDialogHooks = true;
  const record = (entry) => {
    const root = document.documentElement;
    if (!root) return;
    const list = JSON.parse(root.getAttribute('data-skfiy-dialogs') || '[]');
    list.push(entry);
    root.setAttribute('data-skfiy-dialogs', JSON.stringify(list.slice(-10)));
  };
  const answer = () => {
    const root = document.documentElement;
    const raw = root && root.getAttribute('data-skfiy-dialog-answer');
    if (root) root.removeAttribute('data-skfiy-dialog-answer');
    return raw ? JSON.parse(raw) : { accept: true };
  };
  window.alert = function (message) {
    record({ type: 'alert', message: String(message ?? '') });
  };
  window.confirm = function (message) {
    const { accept } = answer();
    record({ type: 'confirm', message: String(message ?? ''), answer: accept });
    return accept;
  };
  window.prompt = function (message, value) {
    const { accept, text } = answer();
    const reply = accept ? (text ?? (value ?? '')) : null;
    record({ type: 'prompt', message: String(message ?? ''), answer: reply });
    return reply;
  };
}

// Only used by test_electron_rendering.py, in its own Electron and data folder.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const inspector = require('inspector');
const arg = name => (process.argv.find(v => v.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const native = require(arg('addon'));
app.setPath('userData', arg('data'));
const [x, y, width, height] = arg('bounds').split(',').map(Number);
app.whenReady().then(() => {
  const windows = [0, 1].map(index => {
    const w = new BrowserWindow({ x, y, width, height, show: false, opacity: 0 });
    w.setIgnoreMouseEvents(true);
    w.loadURL(arg('url') + (index ? '-sibling' : ''));
    w.once('ready-to-show', () => {
      w.showInactive();
      w.moveAbove(`window:${arg('behind')}:0`);
      setTimeout(() => { w.setOpacity(1); w.setIgnoreMouseEvents(false); }, 300);
    });
    return w;
  });
  const target = windows[0];
  let sequence;
  let ticks = 0;
  setInterval(() => {
    const state = { pid: process.pid, ticks: ++ticks, inspector: !!inspector.url(), windows: windows.filter(w => !w.isDestroyed()).map(w => ({
      source: w.getMediaSourceId(), bounds: w.getBounds(), throttling: w.webContents.getBackgroundThrottling(),
      visible: w.isVisible(), focused: w.isFocused()
    })) };
    fs.writeFileSync(arg('state'), JSON.stringify(state));
    let command;
    try { command = JSON.parse(fs.readFileSync(arg('control'), 'utf8')); } catch { return; }
    if (command.sequence === sequence) return;
    sequence = command.sequence;
    if (command.occluded !== undefined) native.setOccluded(target.getNativeWindowHandle(), command.occluded);
    if (command.throttling !== undefined) target.webContents.setBackgroundThrottling(command.throttling);
    if (command.openInspector && !inspector.url()) inspector.open(0, '127.0.0.1', false);
    if (command.closeInspector && inspector.url()) inspector.close();
    if (command.stalledFrames) target.webContents.executeJavaScript('window.requestAnimationFrame=()=>0; true');
    if (command.quit) {
      native.setOccluded(target.getNativeWindowHandle(), false);
      if (inspector.url()) inspector.close();
      app.quit();
    }
  }, 100);
});
app.on('window-all-closed', () => app.quit());

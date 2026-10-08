// An Electron window for the covered-window tests (scripts/test_covered_chromium.py).
// It never shows over the user's windows: it appears fully transparent and
// click-through, is ordered right above a window at the back of the stack
// (the scenario app's, --behind), and only then becomes opaque. The harness
// moves it with a control file, so it can be fully covered or show a corner:
//
//   Electron <this dir> --url=URL --behind=WINDOW_ID --bounds=x,y,w,h --control=FILE --data=DIR
//   FILE: {"bounds": [x, y, w, h]} or {"quit": true}; read every 200 ms
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const arg = (name) => (process.argv.find((value) => value.startsWith(`--${name}=`)) || '').slice(name.length + 3);
app.setPath('userData', arg('data') || '/tmp/skfiy-covered-electron');
const [x, y, width, height] = arg('bounds').split(',').map(Number);

app.whenReady().then(() => {
  const window = new BrowserWindow({ x, y, width, height, show: false, opacity: 0, title: 'skfiy covered' });
  window.setIgnoreMouseEvents(true);
  window.loadURL(arg('url'));
  window.once('ready-to-show', () => {
    window.showInactive();
    try {
      window.moveAbove(`window:${arg('behind')}:0`);
    } catch (error) {
      console.error('moveAbove failed', error);
      app.quit();
      return;
    }
    setTimeout(() => {
      window.setOpacity(1);
      window.setIgnoreMouseEvents(false);
    }, 300);
  });
  let last = '';
  setInterval(() => {
    let text;
    try { text = fs.readFileSync(arg('control'), 'utf8'); } catch { return; }
    if (text === last) return;
    last = text;
    const command = JSON.parse(text);
    if (command.bounds) {
      const [left, top, w, h] = command.bounds;
      window.setBounds({ x: left, y: top, width: w, height: h });
    }
    if (command.quit) app.quit();
  }, 200);
});
app.on('window-all-closed', () => app.quit());

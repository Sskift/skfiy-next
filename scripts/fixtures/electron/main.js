// A plain Electron app for the compatibility tests: one window showing the
// page given on the command line (the local compat page). It opens without
// activating, so the user's front app keeps the focus.
const { app, BrowserWindow } = require('electron');

// Its profile stays in /tmp, out of the user's Application Support.
app.setPath('userData', '/tmp/skfiy-compat/electron-data');
const url = process.argv.find((arg) => /^https?:\/\//.test(arg)) || 'http://127.0.0.1:8766/compat.html';
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 820, height: 760, show: false, title: 'skfiy Electron compat' });
  window.loadURL(url);
  window.once('ready-to-show', () => window.showInactive());
});
app.on('window-all-closed', () => app.quit());

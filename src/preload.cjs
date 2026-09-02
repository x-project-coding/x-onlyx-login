// The header page's only bridge to the app. It sees state and can ask for a handful of actions; it
// has no access to Node, the sign-in view, or anything the creator types.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onlyx', {
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
  close: () => ipcRenderer.send('action', 'close'),
  help: () => ipcRenderer.send('action', 'help'),
  /** The update-ready screen's Restart button. Main refuses it while a run is in progress. */
  installUpdate: () => ipcRenderer.send('action', 'install-update'),
  /** The app menu's Help item, which the page cannot see. */
  onHelp: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('help', handler);
    return () => ipcRenderer.removeListener('help', handler);
  },
});

/**
 * A stand-in for the `electron` module, so `src/main.js` can be imported by a plain Node test.
 *
 * ONLY the surface main.js touches while it is being EVALUATED is real here: the app object it
 * registers its lifecycle handlers on, and the `ipcMain` it hangs the action map from. `whenReady`
 * deliberately returns a promise that never settles, so the window, the menu and the updater — all
 * of which want a real Chromium — are never built. What this stub can therefore prove is what
 * main.js WIRES UP at load, which is exactly where the platform-dependent decisions live.
 *
 * `test/fixtures/electron-hooks.js` is what points the specifier here; the test imports this file
 * directly to read what was registered.
 */

/** Every `app.on(...)` main.js made, newest last, by event name. */
const handlers = new Map();
const calls = { quit: 0, setAsDefaultProtocolClient: [], ipc: new Map() };

export const record = {
  handlers,
  calls,
  /** The last handler registered for an event, or null — `null` is itself an assertable answer. */
  handlerFor: (event) => handlers.get(event)?.at(-1) ?? null,
  reset: () => {
    handlers.clear();
    calls.quit = 0;
    calls.setAsDefaultProtocolClient = [];
    calls.ipc.clear();
    app.isPackaged = false;
    app.singleInstanceLock = true;
  },
};

export const app = {
  isPackaged: false,
  /** What `requestSingleInstanceLock()` answers: false is the "another copy is running" path. */
  singleInstanceLock: true,
  getVersion: () => '0.0.0-test',
  getPath: () => '/tmp',
  requestSingleInstanceLock: () => app.singleInstanceLock,
  setAsDefaultProtocolClient: (...args) => {
    calls.setAsDefaultProtocolClient.push(args);
    return true;
  },
  quit: () => {
    calls.quit += 1;
  },
  exit: () => {
    calls.quit += 1;
  },
  on: (event, fn) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(fn);
    return app;
  },
  once: (event, fn) => app.on(event, fn),
  // NEVER SETTLES: everything main.js does at ready needs a real Chromium, and none of it is what
  // this stub exists to observe.
  whenReady: () => new Promise(() => {}),
  dock: { hide: () => {}, show: () => {} },
};

export const ipcMain = {
  on: (channel, fn) => {
    calls.ipc.set(channel, fn);
  },
  handle: (channel, fn) => {
    calls.ipc.set(channel, fn);
  },
};

export class BrowserWindow {
  static getAllWindows = () => [];
}
export class WebContentsView {}
export const session = { fromPartition: () => ({}), defaultSession: {} };
export const Menu = { buildFromTemplate: (t) => t, setApplicationMenu: () => {} };
export const shell = { openExternal: async () => {} };
export const systemPreferences = {};
export const webContents = { getAllWebContents: () => [] };

export default { app, ipcMain, BrowserWindow, WebContentsView, session, Menu, shell, systemPreferences, webContents };

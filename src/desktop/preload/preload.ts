// Runs in the sandboxed renderer before the page. It exposes a narrow, typed
// bridge; the page never gets ipcRenderer or Node.
import { contextBridge, ipcRenderer } from 'electron';

import type {
  IAppUpdateState,
  IDesktopBridge,
  IDesktopPreferenceKey,
} from '../../shared/desktop_bridge';
import { IPC_CHANNELS } from '../shared/ipc_channels';

const bridge: IDesktopBridge = {
  preferences: {
    load: () => ipcRenderer.invoke(IPC_CHANNELS.loadPreferences),
    set: (key: IDesktopPreferenceKey, value: string) => {
      ipcRenderer.send(IPC_CHANNELS.setPreference, key, value);
    },
  },
  updates: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.getUpdateState),
    onState: listener => {
      const handler = (_event: unknown, state: IAppUpdateState) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.updateState, handler);
      return () => {
        ipcRenderer.off(IPC_CHANNELS.updateState, handler);
      };
    },
    check: () => ipcRenderer.invoke(IPC_CHANNELS.checkForUpdates),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.installUpdate),
    skip: version => ipcRenderer.invoke(IPC_CHANNELS.skipUpdate, version),
  },
  find: {
    open: () => ipcRenderer.send(IPC_CHANNELS.openFindBar),
    step: isForward => ipcRenderer.send(IPC_CHANNELS.stepFindBar, isForward),
    onOpenChange: listener => {
      const handler = (_event: unknown, isOpen: boolean) => listener(isOpen);
      ipcRenderer.on(IPC_CHANNELS.findBarState, handler);
      return () => {
        ipcRenderer.off(IPC_CHANNELS.findBarState, handler);
      };
    },
    onBack: listener => {
      const handler = () => listener();
      ipcRenderer.on(IPC_CHANNELS.findBarBack, handler);
      return () => {
        ipcRenderer.off(IPC_CHANNELS.findBarBack, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('pm2CaptainDesktop', bridge);

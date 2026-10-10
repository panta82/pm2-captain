import { createContext, useContext } from 'react';

export interface IDaemonSelection {
  /** Null until the daemon list has loaded. */
  selectedDaemonId: string | null;
  selectDaemon: (daemonId: string) => void;
}

const DaemonSelectionContext = createContext<IDaemonSelection>({
  selectedDaemonId: null,
  selectDaemon: () => undefined,
});

export function DaemonSelectionProvider({
  value,
  children,
}: {
  value: IDaemonSelection;
  children: React.ReactNode;
}) {
  return (
    <DaemonSelectionContext.Provider value={value}>{children}</DaemonSelectionContext.Provider>
  );
}

export function useDaemonSelection(): IDaemonSelection {
  return useContext(DaemonSelectionContext);
}

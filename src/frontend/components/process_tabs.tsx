import { Activity, memo, useState } from 'react';

import { useDaemonConnectionId } from '@/lib/daemon_connection';
import { type ProcessTab, processRouteApi } from '@/lib/process_route';

import { EnvPage } from '@/pages/env_page';
import { InfoPage } from '@/pages/info_page';
import { LogsPage } from '@/pages/logs_page';

// Stable children let a visibility change reuse the tab's rendered tree.
const TAB_PAGES = { info: <InfoPage />, env: <EnvPage /> };

/** Retains visited tabs for the current selection, without running hidden effects or streams. */
export const ProcessTabs = memo(function ProcessTabs({
  tab,
  selectionKey,
}: {
  tab: ProcessTab;
  selectionKey: string;
}) {
  const daemonId = processRouteApi.useParams({ select: params => params.daemonId });
  // A daemon moved to another location gets a fresh log view: its history,
  // cursors and stream belong to the old location.
  const connectionId = useDaemonConnectionId(daemonId);
  const [selection, setSelection] = useState({ key: selectionKey, tabs: [tab] });
  if (selection.key !== selectionKey) {
    // Discard the old selection's hidden tabs, but reuse the active Info/Env DOM.
    setSelection({ key: selectionKey, tabs: [tab] });
  } else if (!selection.tabs.includes(tab)) {
    // Record the visit during render so the new tab appears in the same commit.
    setSelection({ ...selection, tabs: [...selection.tabs, tab] });
  }

  return selection.tabs.map(visitedTab => (
    <Activity key={visitedTab} mode={visitedTab === tab ? 'visible' : 'hidden'}>
      {visitedTab === 'logs' ? (
        <LogsPage key={`${selectionKey}:${connectionId}`} connectionId={connectionId} />
      ) : (
        TAB_PAGES[visitedTab]
      )}
    </Activity>
  ));
});

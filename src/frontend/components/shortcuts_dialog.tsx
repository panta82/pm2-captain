import { X } from 'lucide-react';
import { useEffect } from 'react';

import { useKeyboardShortcuts } from '@/lib/keyboard_shortcuts';
import { desktopBridge } from '@/lib/preferences';
import { cn } from '@/lib/utils';

import { type IKeyboardActionGroup, KEYBOARD_ACTIONS } from '@shared/keybindings';

import { Kbd } from './shortcut_hint';
import { Button } from './ui';

const GROUPS: IKeyboardActionGroup[] = ['Search', 'Processes', 'Navigation', 'Logs', 'Help'];

interface IShortcutRow {
  label: string;
  /** The action's name in keybindings.json; fixed keys have none. */
  actionId?: string;
  keys: string[];
}

function KeyList({ keys }: { keys: string[] }) {
  return keys.length ? (
    <span className="flex gap-1">
      {keys.map(key => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  ) : null;
}

/** Every shortcut in effect, and where to change them. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { labels, settings } = useKeyboardShortcuts();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const sections: Array<{ title: string; rows: IShortcutRow[] }> = [
    ...GROUPS.map(group => ({
      title: group,
      rows: KEYBOARD_ACTIONS.filter(action => action.group === group).map(action => ({
        label: action.label,
        actionId: action.id,
        keys: labels[action.id] ?? [],
      })),
    })),
  ];

  return (
    <div
      data-component="ShortcutsDialog"
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-dialog-title"
        className="flex max-h-[92svh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-surface-plane shadow-2xl"
      >
        <header className="flex items-center justify-between gap-4 border-b border-line pl-5 pr-2 py-2">
          <div>
            <h2 id="shortcuts-dialog-title" className="mb-0 font-semibold text-white">
              Keyboard shortcuts
            </h2>
          </div>
          <Button
            variant="ghost"
            className="size-9 shrink-0 p-0"
            aria-label="Close"
            autoFocus
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* One table, so the names and keys line up in columns across the groups. */}
          <table className="w-full border-collapse text-sm">
            {sections.map((section, index) => (
              <tbody key={section.title}>
                <tr>
                  <th
                    colSpan={3}
                    scope="colgroup"
                    className={cn(
                      'pb-1.5 text-left text-[11px] font-semibold tracking-wide text-muted uppercase',
                      index > 0 && 'pt-5'
                    )}
                  >
                    {section.title}
                  </th>
                </tr>
                {section.rows.map(row => (
                  <tr key={row.label}>
                    <td className="py-1 pr-4 pl-5 align-middle text-control-muted">{row.label}</td>
                    <td className="py-1 pr-4 align-middle font-mono text-[11px] whitespace-nowrap text-muted">
                      {row.actionId}
                    </td>
                    <td className="py-1 align-middle whitespace-nowrap">
                      <KeyList keys={row.keys} />
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
        <footer className="border-t border-line px-5 py-3 text-xs leading-5 text-muted">
          {settings?.error ? (
            <p className="text-danger">
              {settings.path} is ignored: {settings.error}
            </p>
          ) : null}
          <p>
            Keys can be customized in{' '}
            <code className="font-mono text-control-muted">
              {settings?.path ?? 'keybindings.json'}
            </code>
            . See the{' '}
            <a
              href={'https://github.com/panta82/pm2-captain'}
              target={'_blank'}
              className={'text-control-muted underline'}
            >
              README
            </a>{' '}
            for more details.
          </p>
        </footer>
      </section>
    </div>
  );
}

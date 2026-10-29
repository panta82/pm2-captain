import { Ban, LoaderCircle, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import {
  type ChangeEvent,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import { toast } from 'sonner';

import { useDaemonSelection } from '@/lib/daemon_selection';
import { fieldsToSshArgs, sshArgsToFields } from '@/lib/ssh_arguments';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import {
  DAEMON_COLORS,
  type IDaemonColor,
  type IDaemonConfig,
  type IDaemonInput,
  type IDaemonKind,
  type IDaemonSummary,
} from '@shared/contracts';

import {
  DAEMON_OPTION_LIST_CLASS,
  DaemonOption,
  DaemonStatusIcon,
  daemonColorStyle,
} from './daemon_option';
import { Button, ToggleGroup } from './ui';

type IDaemonManagerView = 'daemon' | 'add';

const DaemonManagerApiContext = createContext<{ open: (view?: IDaemonManagerView) => void }>({
  open: () => undefined,
});

export function DaemonManagerProvider({ children }: { children: ReactNode }) {
  const [openView, setOpenView] = useState<IDaemonManagerView | null>(null);
  const api = useMemo(
    () => ({ open: (view: IDaemonManagerView = 'daemon') => setOpenView(view) }),
    []
  );
  const close = useCallback(() => setOpenView(null), []);

  return (
    <DaemonManagerApiContext.Provider value={api}>
      {children}
      {openView ? <DaemonManager initialView={openView} onClose={close} /> : null}
    </DaemonManagerApiContext.Provider>
  );
}

export function useDaemonManager() {
  return useContext(DaemonManagerApiContext);
}

function DaemonOverview({ daemon }: { daemon: IDaemonSummary }) {
  const utils = trpc.useUtils();
  const retry = trpc.daemons.retry.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.daemons.list.invalidate(), utils.processes.list.invalidate()]);
    },
    onError: error => toast.error(error.message),
  });

  return (
    <div data-component="DaemonOverview" className="flex items-start gap-3">
      <DaemonStatusIcon status={daemon.status} color={daemon.color} className="mt-1" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3
            className="truncate text-sm font-semibold text-white"
            style={daemonColorStyle(daemon.color)}
          >
            {daemon.label}
          </h3>
          <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted">
            {daemon.kind}
          </span>
        </div>
        <div className="mt-1 font-mono text-[10px] uppercase text-muted">{daemon.status}</div>
        {daemon.error ? <p className="mt-1 text-xs text-danger">{daemon.error}</p> : null}
      </div>
      {daemon.status === 'error' || daemon.status === 'offline' ? (
        <Button
          variant="ghost"
          className="size-8 shrink-0 p-0"
          disabled={retry.isPending}
          aria-label={`Retry ${daemon.label}`}
          onClick={() => retry.mutate({ daemonId: daemon.daemonId })}
        >
          {retry.isPending ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
      ) : null}
    </div>
  );
}

function TextField({
  label,
  hint,
  isMonospace = true,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  hint?: ReactNode;
  isMonospace?: boolean;
}) {
  const hintId = useId();

  return (
    <div data-component="TextField" className="text-xs text-muted">
      <label className="block">
        {label}
        <input
          {...props}
          aria-describedby={hint ? hintId : undefined}
          className={cn(
            'mt-1.5 h-10 w-full rounded-md border border-line bg-input px-3 text-sm text-white outline-none placeholder:text-muted/70 focus:border-cyan focus:bg-input-focus',
            isMonospace && 'font-mono'
          )}
        />
      </label>
      {hint ? (
        <p id={hintId} className="mt-1.5 leading-5 opacity-80">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function DaemonColorField({
  value,
  onChange,
}: {
  value: IDaemonColor | null;
  onChange: (color: IDaemonColor | null) => void;
}) {
  const name = useId();

  return (
    <fieldset data-component="DaemonColorField" className="text-xs text-muted">
      <legend>
        Color <span className="opacity-60">(optional)</span>
      </legend>
      <div className="mt-2 flex flex-wrap gap-2.5">
        {[null, ...DAEMON_COLORS].map(color => (
          <span key={color ?? 'none'} className="relative grid">
            <input
              type="radio"
              name={name}
              title={color ?? 'none'}
              aria-label={color ?? 'none'}
              checked={value === color}
              onChange={() => onChange(color)}
              className="size-6 cursor-pointer appearance-none rounded-full border border-line bg-input checked:ring-2 checked:ring-white checked:ring-offset-2 checked:ring-offset-surface-plane focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan"
              style={color ? { backgroundColor: `var(--color-daemon-${color})` } : undefined}
            />
            {color ? null : (
              <Ban
                aria-hidden
                className="pointer-events-none absolute inset-0 m-auto size-3.5 text-muted"
              />
            )}
          </span>
        ))}
      </div>
      <p className="mt-2 leading-5 opacity-80">
        Colors the daemon's name, for example red for production.
      </p>
    </fieldset>
  );
}

/** The fields a user edits, as the server compares them for a conflicting edit. */
function editableInput(config: IDaemonConfig): IDaemonInput {
  const appearance = {
    ...(config.label ? { label: config.label } : {}),
    ...(config.color ? { color: config.color } : {}),
  };
  return config.kind === 'local'
    ? { kind: 'local', pm2Home: config.pm2Home, ...appearance }
    : {
        kind: 'ssh',
        sshArgs: config.sshArgs,
        ...(config.pm2Home ? { pm2Home: config.pm2Home } : {}),
        ...appearance,
      };
}

function toFields(kind: IDaemonKind, config: IDaemonConfig | null) {
  return {
    ...sshArgsToFields(config?.kind === 'ssh' ? config.sshArgs : []),
    pm2Home: config?.pm2Home ?? (kind === 'local' ? '~/.pm2' : ''),
    label: config?.label ?? '',
    color: config?.color ?? null,
  };
}

function DaemonForm({
  kind,
  config,
  onAdded,
}: {
  kind: IDaemonKind;
  /** Null for a daemon that does not exist yet. */
  config: IDaemonConfig | null;
  onAdded: (daemonId: string) => void;
}) {
  // The daemon as this form loaded or last saved it. Saving sends it along, so
  // an edit made elsewhere in the meantime is reported instead of overwritten.
  const [baseline, setBaseline] = useState(config);
  const stored = toFields(kind, baseline);
  const [fields, setFields] = useState(stored);
  const [isChangedElsewhere, setIsChangedElsewhere] = useState(false);
  const onSaveError = (error: { message: string; data?: { appCode?: string | null } | null }) => {
    if (error.data?.appCode === 'DAEMON_CHANGED') {
      setIsChangedElsewhere(true);
    }
    toast.error(error.message);
  };
  const utils = trpc.useUtils();
  const invalidate = () =>
    Promise.all([utils.daemons.list.invalidate(), utils.processes.list.invalidate()]);
  const add = trpc.daemons.add.useMutation({
    onSuccess: async result => {
      toast.success(
        result.added ? `Added ${result.daemon.label}` : `${result.daemon.label} is already added`
      );
      await invalidate();
      onAdded(result.daemon.daemonId);
    },
    onError: error => toast.error(error.message),
  });
  const update = trpc.daemons.update.useMutation({
    onSuccess: async result => {
      toast.success(`Saved ${result.label}`);
      // Show what was stored, which can be normalized differently than typed.
      setBaseline(result.config);
      setFields(toFields(kind, result.config));
      setIsChangedElsewhere(false);
      await invalidate();
    },
    onError: onSaveError,
  });
  const remove = trpc.daemons.remove.useMutation({
    onSuccess: async () => {
      toast.success('Daemon removed');
      await invalidate();
    },
    onError: onSaveError,
  });

  const isSshArgsChanged =
    fields.destination !== stored.destination ||
    fields.port !== stored.port ||
    fields.options !== stored.options;
  const isDirty =
    isSshArgsChanged ||
    fields.pm2Home !== stored.pm2Home ||
    fields.label !== stored.label ||
    fields.color !== stored.color;
  const isBusy = add.isPending || update.isPending || remove.isPending;

  const setField =
    (name: Exclude<keyof typeof fields, 'color'>) => (event: ChangeEvent<HTMLInputElement>) =>
      setFields(current => ({ ...current, [name]: event.target.value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const label = fields.label.trim();
    const pm2Home = fields.pm2Home.trim();
    const appearance = {
      ...(label ? { label } : {}),
      ...(fields.color ? { color: fields.color } : {}),
    };
    let input: IDaemonInput;
    if (kind === 'local') {
      input = { kind, pm2Home, ...appearance };
    } else {
      let sshArgs: string[];
      try {
        // Untouched connection fields keep the stored arguments verbatim, so
        // renaming a daemon never reorders them and forces a reconnect.
        sshArgs =
          baseline?.kind === 'ssh' && !isSshArgsChanged
            ? baseline.sshArgs
            : fieldsToSshArgs(fields);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Invalid SSH options');
        return;
      }
      input = { kind, sshArgs, ...(pm2Home ? { pm2Home } : {}), ...appearance };
    }
    if (baseline) {
      update.mutate({
        daemonId: baseline.daemonId,
        daemon: input,
        expected: editableInput(baseline),
      });
    } else {
      add.mutate(input);
    }
  };

  return (
    <form data-component="DaemonForm" onSubmit={submit} className="space-y-3">
      {isChangedElsewhere && config ? (
        <div className="rounded-md border border-line bg-panel p-3 text-sm leading-5">
          This daemon was changed elsewhere since you opened it. Your edits are still here.{' '}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={async () => {
              // Always a fresh read: the polled list may predate the change.
              // Without one, the draft and this notice stay.
              let settings;
              try {
                settings = await utils.daemons.list.fetch(undefined, {
                  staleTime: 0,
                  retry: false,
                });
              } catch (error) {
                toast.error(
                  `Unable to load the saved version: ${
                    error instanceof Error ? error.message : 'the daemon list could not be read.'
                  }`
                );
                return;
              }
              const saved = settings.find(
                daemon => daemon.config.daemonId === config.daemonId
              )?.config;
              if (!saved) {
                toast.error('This daemon is no longer in the saved list.');
                return;
              }
              setBaseline(saved);
              setFields(toFields(kind, saved));
              setIsChangedElsewhere(false);
            }}
          >
            Load the saved version
          </button>
        </div>
      ) : null}
      {kind === 'local' ? (
        <TextField
          label="PM2 home"
          required
          autoFocus={!config}
          value={fields.pm2Home}
          placeholder="~/.pm2"
          onChange={setField('pm2Home')}
          hint="A PM2 daemon directory on this computer."
        />
      ) : (
        <>
          <TextField
            label="SSH destination"
            required
            autoFocus={!config}
            value={fields.destination}
            placeholder="user@example.com or SSH config alias"
            onChange={setField('destination')}
          />
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <TextField
              label="Port"
              type="number"
              min="1"
              max="65535"
              value={fields.port}
              placeholder="22"
              onChange={setField('port')}
            />
            <TextField
              label="Extra SSH options"
              value={fields.options}
              placeholder="-J jump-host"
              onChange={setField('options')}
            />
          </div>
          <TextField
            label={
              <>
                PM2 home <span className="opacity-60">(optional)</span>
              </>
            }
            value={fields.pm2Home}
            placeholder="Remote PM2_HOME, else ~/.pm2"
            onChange={setField('pm2Home')}
            hint="A path on the server. A leading ~ is the remote user's home directory."
          />
        </>
      )}
      <TextField
        label={
          <>
            Label <span className="opacity-60">(optional)</span>
          </>
        }
        isMonospace={false}
        value={fields.label}
        onChange={setField('label')}
      />
      <DaemonColorField
        value={fields.color}
        onChange={color => setFields(current => ({ ...current, color }))}
      />
      <div className="flex flex-wrap items-center gap-2 pt-2">
        {config ? (
          <Button
            type="button"
            variant="danger"
            disabled={isBusy}
            onClick={() => {
              if (
                window.confirm(
                  'Remove this daemon from Captain? This does not stop PM2 or any applications.'
                )
              ) {
                remove.mutate({
                  daemonId: config.daemonId,
                  expected: editableInput(baseline ?? config),
                });
              }
            }}
          >
            {remove.isPending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            Delete
          </Button>
        ) : null}
        <div className="flex-1" />
        {config ? (
          <Button type="button" disabled={!isDirty || isBusy} onClick={() => setFields(stored)}>
            Reset
          </Button>
        ) : null}
        <Button variant="primary" type="submit" disabled={isBusy || Boolean(config && !isDirty)}>
          {add.isPending || update.isPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : config ? (
            <Save className="size-4" />
          ) : (
            <Plus className="size-4" />
          )}
          {config ? 'Save' : 'Add daemon'}
        </Button>
      </div>
    </form>
  );
}

export function DaemonManager({
  initialView,
  onClose,
}: {
  initialView: IDaemonManagerView;
  onClose: () => void;
}) {
  const { selectedDaemonId } = useDaemonSelection();
  const [activeDaemonId, setActiveDaemonId] = useState(selectedDaemonId);
  const [isAdding, setIsAdding] = useState(initialView === 'add');
  const [addKind, setAddKind] = useState<IDaemonKind>('ssh');
  const settings = trpc.daemons.list.useQuery(undefined, { refetchInterval: 2_000 });
  const list = trpc.processes.list.useQuery(undefined, { refetchInterval: 2_000 });
  const daemons = settings.data || [];
  const isAddView = isAdding || (settings.isSuccess && !daemons.length);
  // A removed daemon falls back to the first remaining one.
  const activeDaemon = isAddView
    ? undefined
    : (daemons.find(daemon => daemon.daemonId === activeDaemonId) ?? daemons[0]);

  const showDaemon = (daemonId: string) => {
    setActiveDaemonId(daemonId);
    setIsAdding(false);
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      data-component="DaemonManager"
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      onMouseDown={event => {
        // Dismiss only when the press starts on the backdrop, so dragging a
        // text selection out of an input does not close the dialog.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="daemon-manager-title"
        className="flex h-[min(640px,92svh)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-surface-plane shadow-2xl"
      >
        <header className="border-b border-line px-5 py-4">
          <h2 id="daemon-manager-title" className="font-semibold text-white">
            PM2 daemons
          </h2>
          <p className="mt-1 text-xs text-muted">
            Connect to your local or remote PM2 daemons to manage applications and view logs.
          </p>
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <div
            role="tablist"
            aria-label="Daemons"
            aria-orientation="vertical"
            className={cn(
              DAEMON_OPTION_LIST_CLASS,
              'max-h-44 shrink-0 content-start overflow-y-auto border-b border-line py-2 sm:max-h-none sm:w-72 sm:border-r sm:border-b-0'
            )}
          >
            {daemons.map(daemon => (
              <DaemonOption
                key={daemon.daemonId}
                role="tab"
                aria-selected={daemon === activeDaemon}
                daemon={daemon}
                processes={list.data?.processes || []}
                isSelected={daemon === activeDaemon}
                onClick={() => showDaemon(daemon.daemonId)}
              />
            ))}
            <button
              type="button"
              role="tab"
              aria-selected={isAddView}
              className={cn(
                'col-span-full flex items-center gap-2.5 px-3 py-2 text-left font-mono text-xs focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-cyan/60',
                isAddView ? 'bg-panel-hover text-white' : 'text-control-muted hover:bg-panel'
              )}
              onClick={() => setIsAdding(true)}
            >
              <Plus className="size-3.5 shrink-0" aria-hidden />
              Add daemon
            </button>
          </div>
          <div role="tabpanel" className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto p-5">
            {isAddView ? (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-white">Add daemon</h3>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      {addKind === 'ssh'
                        ? 'Connect to a remote PM2 daemon via SSH'
                        : 'Add a local PM2 daemon'}
                    </p>
                  </div>
                  <ToggleGroup aria-label="Daemon type" className="h-8">
                    {(['ssh', 'local'] as const).map(kind => (
                      <Button
                        key={kind}
                        variant="toggle"
                        aria-pressed={addKind === kind}
                        className="h-full px-3 text-xs"
                        onClick={() => setAddKind(kind)}
                      >
                        {kind === 'ssh' ? 'SSH' : 'Local'}
                      </Button>
                    ))}
                  </ToggleGroup>
                </div>
                <DaemonForm
                  key={`new-${addKind}`}
                  kind={addKind}
                  config={null}
                  onAdded={showDaemon}
                />
              </>
            ) : activeDaemon ? (
              <>
                <DaemonOverview daemon={activeDaemon} />
                <DaemonForm
                  key={activeDaemon.daemonId}
                  kind={activeDaemon.config.kind}
                  config={activeDaemon.config}
                  onAdded={showDaemon}
                />
              </>
            ) : null}
          </div>
        </div>
        <footer className="flex justify-end border-t border-line px-5 py-3">
          <Button onClick={onClose}>Close</Button>
        </footer>
      </section>
    </div>
  );
}

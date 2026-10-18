import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, httpSubscriptionLink, splitLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import { type PropsWithChildren, useState } from 'react';

import { desktopBridge } from '@/lib/preferences';
import { IUpdatesAPI, UpdatesAPIProvider, createDesktopUpdatesAPI } from '@/lib/updates_api';

import type { IAppRouter } from '../../backend/web/app_router';

export const trpc = createTRPCReact<IAppRouter>();

export function APIProvider({ children }: PropsWithChildren) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 2,
            // Process status polls every two seconds; navigation can reuse that snapshot.
            staleTime: 2_000,
          },
        },
      })
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        splitLink({
          condition: operation => operation.type === 'subscription',
          true: httpSubscriptionLink({
            url: '/api/trpc',
          }),
          false: httpBatchLink({
            url: '/api/trpc',
          }),
        }),
      ],
    })
  );
  const [updatesAPI] = useState<IUpdatesAPI>(() => {
    if (desktopBridge) {
      return createDesktopUpdatesAPI(desktopBridge.updates);
    }

    return {
      subscribe: (onState, onError) => {
        const subscription = client.updates.state.subscribe(undefined, {
          onData: onState,
          onError,
        });
        return () => subscription.unsubscribe();
      },
      install: async () => {
        await client.updates.install.mutate();
      },
      skip: async version => {
        await client.updates.skip.mutate({ version });
      },
    };
  });

  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <UpdatesAPIProvider api={updatesAPI}>{children}</UpdatesAPIProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink, httpSubscriptionLink, splitLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import { type PropsWithChildren, useState } from 'react';

import type { IAppRouter } from '../../backend/web/app_router';

export const trpc = createTRPCReact<IAppRouter>();

export function APIProvider({ children }: PropsWithChildren) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 2,
            staleTime: 500,
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

  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { APIProvider } from '@/lib/trpc';
import { Root } from '@/root';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <APIProvider>
      <Root />
    </APIProvider>
  </StrictMode>
);

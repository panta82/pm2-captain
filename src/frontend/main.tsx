import './styles.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { loadPreferences } from '@/lib/preferences';
import { APIProvider } from '@/lib/trpc';

import { Root } from '@/root';

// The desktop app's preferences have to be there for the first render.
void loadPreferences().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <APIProvider>
        <Root />
      </APIProvider>
    </StrictMode>
  );
});

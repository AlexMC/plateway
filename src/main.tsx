import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import { loadLibrary } from './domain/library';
import { ErrorBoundary } from './editor/error-boundary';
import { Workspace } from './editor/workspace';
import { installErrorReporter } from './net/telemetry';
import './editor/styles.css';

installErrorReporter();
// Community pieces register from the index before the draft is parsed (KTD9); the first render waits for the index only,
// never for a train or furniture file, which register later and redraw the open layout. The load never throws.
void loadLibrary().indexed.then(() => createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ErrorBoundary><Workspace /></ErrorBoundary></React.StrictMode>
));

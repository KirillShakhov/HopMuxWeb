import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import '@xyflow/react/dist/style.css';
import '@xterm/xterm/css/xterm.css';
import './theme.css';
import './style.css';
import './graph.css';
import { App } from './App';
import { VaultProvider } from './VaultView';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <VaultProvider><App /></VaultProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

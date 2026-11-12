import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import './graph.css';
import './polish.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

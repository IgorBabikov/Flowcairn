import React from 'react';
import { createRoot } from 'react-dom/client';
import { App, AppErrorBoundary } from './App';
import './app.css';
import './navigation.css';
import './wide-workspace.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing');

createRoot(root).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);

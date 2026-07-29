import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// ترتيب مقصود: الخط، ثم ثيم ناف (وفيه Tailwind والرموز)، ثم أنماط المنصة التي تستهلكها.
import './naf/naf-font.css';
import './naf/naf-theme.css';
import './naf/naf-app-shell.css';
import './naf/naf-safe-area.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

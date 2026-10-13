import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/noto-sans-arabic/400.css';
import '@fontsource/noto-sans-arabic/500.css';
import '@fontsource/noto-sans-arabic/600.css';
import '@fontsource/noto-sans-arabic/700.css';
import { App } from './App.js';
import { Storefront } from './Storefront.js';
import './styles.css';
import './operations-theme.css';
import './workflow-ux.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{location.pathname === '/shop' ? <Storefront /> : <App />}</React.StrictMode>,
);

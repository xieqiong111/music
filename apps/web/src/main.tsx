import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import { zhCN } from './i18n/zh-CN.js';
import './styles.css';

document.title = zhCN.appTitle;

const root = document.getElementById('root');
if (root === null) throw new Error('Missing application root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}

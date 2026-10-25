import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/index.css';
import './styles/mobile.css';
import './styles/character-creation.css';
import './styles/cross-page.css';
import './styles/theme.css';
import './styles/motion.css';
import './styles/live-integration.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

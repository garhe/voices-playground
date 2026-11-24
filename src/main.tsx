import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installExclusivePlayback } from './exclusivePlayback';
import './style.css';

installExclusivePlayback(document);

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

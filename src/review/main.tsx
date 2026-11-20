import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/pages.css';
import '../editor/editor.css';
import './review.css';
import { ReviewApp } from './ReviewApp';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');
const captureId = new URLSearchParams(location.search).get('capture');
createRoot(root).render(
  <StrictMode>
    <ReviewApp captureId={captureId} />
  </StrictMode>,
);

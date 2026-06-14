import './styles.css';
import { startDraftApp, startDebugMode } from './draft/DraftApp';

if (new URLSearchParams(window.location.search).has('debug')) {
  startDebugMode();
} else {
  startDraftApp();
}

import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  // No StrictMode: double-mounting would tear down a live video decoder.
  <App />
)

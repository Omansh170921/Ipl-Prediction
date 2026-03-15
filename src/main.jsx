import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { ErrorBoundary } from './components/ErrorBoundary'

const rootEl = document.getElementById('root')
if (!rootEl) {
  document.body.innerHTML = '<div style="padding:2rem;font-family:sans-serif"><h2>Error</h2><p>Root element not found.</p></div>'
} else {
  try {
    createRoot(rootEl).render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    )
  } catch (err) {
    console.error('Failed to render app:', err)
    rootEl.innerHTML = `<div style="padding:2rem;font-family:sans-serif;color:#333"><h2>Something went wrong</h2><pre>${String(err?.message || err)}</pre><button onclick="location.reload()">Reload</button></div>`
  }
}

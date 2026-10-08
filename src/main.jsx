import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// If the deployment is protected with APP_PASSWORD, every /api call must carry
// the access key. Injecting it here means no per-component changes and no
// missed fetch calls. The key is a deployment gate, not a user credential.
const origFetch = window.fetch.bind(window)
window.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || ''
  if (url.startsWith('/api')) {
    let key = null
    try { key = localStorage.getItem('sb_app_key') } catch { /* private mode */ }
    if (key) {
      // Spreading init.headers as a plain object silently produced {} for a
      // Headers instance, dropping every caller-set header. Normalising through
      // Headers handles objects, arrays of pairs and Headers alike.
      const headers = new Headers(init.headers || {})
      headers.set('x-shipbridge-key', key)
      init = { ...init, headers }
    }
  }
  return origFetch(input, init)
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

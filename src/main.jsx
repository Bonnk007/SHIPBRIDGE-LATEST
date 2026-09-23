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
    const key = localStorage.getItem('sb_app_key')
    if (key) init = { ...init, headers: { ...(init.headers || {}), 'x-shipbridge-key': key } }
  }
  return origFetch(input, init)
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

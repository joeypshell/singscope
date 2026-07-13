import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App.tsx'
import './index.css'

const updateSW = registerSW({
  immediate: false,
  onNeedRefresh: () => window.dispatchEvent(new CustomEvent('singscope:update-ready')),
})
window.addEventListener('singscope:apply-update', () => {
  void updateSW(true)
})

const root = document.getElementById('root')
if (!root) throw new Error('Application root is missing')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

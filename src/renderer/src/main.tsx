import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/source-serif-4/index.css'
import 'katex/dist/katex.min.css'
import './styles/theme.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

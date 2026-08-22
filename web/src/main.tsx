import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Tutor from './Tutor'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Tutor />
  </StrictMode>,
)

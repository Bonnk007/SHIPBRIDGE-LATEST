import { useState, useRef, useEffect } from 'react'

// Draggable floating action button. Click opens, drag repositions.
// Position persists across sessions; clamped to the viewport on resize.
export default function DraggableFab({ onClick, title = 'AI Assistant', children }) {
  const [pos, setPos] = useState(() => {
    const clampX = (x) => Math.min(Math.max(8, x), window.innerWidth - 60)
    const clampY = (y) => Math.min(Math.max(8, y), window.innerHeight - 60)
    try {
      const saved = JSON.parse(localStorage.getItem('tf_fab_pos') || 'null')
      if (saved && typeof saved.x === 'number' && typeof saved.y === 'number')
        return { x: clampX(saved.x), y: clampY(saved.y) }   // clamp on load — saved pos may be from a bigger screen
    } catch {}
    return { x: window.innerWidth - 76, y: window.innerHeight - 76 }
  })
  const drag = useRef(null)   // { startX, startY, origX, origY, moved }

  // Keep the button on-screen if the window shrinks
  useEffect(() => {
    const clamp = () => setPos(p => ({
      x: Math.min(Math.max(8, p.x), window.innerWidth - 60),
      y: Math.min(Math.max(8, p.y), window.innerHeight - 60),
    }))
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])

  function onPointerDown(e) {
    drag.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e) {
    if (!drag.current) return
    const dx = e.clientX - drag.current.startX
    const dy = e.clientY - drag.current.startY
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.current.moved = true
    if (drag.current.moved) {
      setPos({
        x: Math.min(Math.max(8, drag.current.origX + dx), window.innerWidth - 60),
        y: Math.min(Math.max(8, drag.current.origY + dy), window.innerHeight - 60),
      })
    }
  }
  function onPointerUp() {
    if (!drag.current) return
    const wasDrag = drag.current.moved
    drag.current = null
    if (wasDrag) {
      setPos(p => { localStorage.setItem('tf_fab_pos', JSON.stringify(p)); return p })
    } else {
      onClick?.()
    }
  }

  return (
    <button title={`${title} — drag to move`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 150,
        width: 52, height: 52, borderRadius: '50%', border: 'none',
        background: 'linear-gradient(135deg,#1f6feb,#3fb950)',
        boxShadow: '0 4px 20px rgba(31,111,235,0.4)', cursor: 'grab',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 22, touchAction: 'none', userSelect: 'none',
      }}>
      {children}
    </button>
  )
}

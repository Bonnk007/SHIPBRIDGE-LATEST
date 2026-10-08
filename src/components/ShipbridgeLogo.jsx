// SHIPBRIDGE wordmark. One continuous tracked word — no separated word gaps.
export function ShipbridgeMark({ size = 30, color = 'var(--blue)' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M3 17 V11 M21 17 V11 M3 12 Q12 4 21 12" stroke={color} strokeWidth="2" strokeLinecap="round" fill="none"/>
      <path d="M3 17 H21" stroke={color} strokeWidth="2" strokeLinecap="round"/>
      <path d="M8 17 V13 M12 17 V12 M16 17 V13" stroke={color} strokeWidth="1.6" strokeLinecap="round" opacity="0.7"/>
    </svg>
  )
}

export default function ShipbridgeLogo({ height = 17, color = 'currentColor', accent = 'var(--blue)' }) {
  return (
    <span style={{
      fontFamily: 'Inter, system-ui, sans-serif',
      fontWeight: 600, fontSize: height, letterSpacing: '0.16em',
      lineHeight: 1, display: 'inline-block', whiteSpace: 'nowrap',
    }}>
      <span style={{ color }}>SHIP</span><span style={{ color: accent }}>BRIDGE</span>
    </span>
  )
}

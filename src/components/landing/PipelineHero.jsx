import { useRef, useMemo } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'

// ── Liquid copper shader: flowing domain-warped noise + grain ──────────────
const liquidMaterial = () => new THREE.ShaderMaterial({
  transparent: true,
  uniforms: {
    uTime: { value: 0 },
    uColorDeep: { value: new THREE.Color('#0a0f1c') },
    uColorMid:  { value: new THREE.Color('#1d3a6b') },
    uColorHot:  { value: new THREE.Color('#4f8ff7') },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    precision highp float;
    varying vec2 vUv;
    uniform float uTime;
    uniform vec3 uColorDeep, uColorMid, uColorHot;

    // value noise
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
    float noise(vec2 p){
      vec2 i=floor(p), f=fract(p);
      vec2 u=f*f*(3.0-2.0*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),
                 mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);
    }
    float fbm(vec2 p){
      float v=0.0, a=0.5;
      for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.0; a*=0.5; }
      return v;
    }
    void main(){
      vec2 uv = vUv * 3.0;
      float t = uTime * 0.08;
      // domain warp — this is what gives the liquid flow
      vec2 q = vec2(fbm(uv + t), fbm(uv + vec2(5.2,1.3) - t));
      vec2 r = vec2(fbm(uv + 4.0*q + vec2(1.7,9.2) + t*0.5),
                    fbm(uv + 4.0*q + vec2(8.3,2.8) - t*0.5));
      float f = fbm(uv + 4.0*r);
      vec3 col = mix(uColorDeep, uColorMid, smoothstep(0.0,0.7,f));
      col = mix(col, uColorHot, smoothstep(0.55,0.95,f) * 0.6);
      // grain
      float g = hash(vUv * 800.0 + uTime) * 0.04;
      col += g - 0.02;
      // vignette so the pipeline stays the focus
      float vig = smoothstep(1.1, 0.3, length(vUv - 0.5));
      gl_FragColor = vec4(col, 0.85 * vig);
    }
  `,
})

function LiquidBackdrop() {
  const mat = useMemo(liquidMaterial, [])
  const { viewport } = useThree()
  useFrame(({ clock }) => { mat.uniforms.uTime.value = clock.elapsedTime })
  return (
    <mesh position={[0, 0, -3]} material={mat}>
      <planeGeometry args={[viewport.width * 2.2, viewport.height * 2.2]} />
    </mesh>
  )
}

// The pipeline: a curved path sweeping across the viewport.
function usePipeCurve() {
  return useMemo(() => new THREE.CatmullRomCurve3([
    new THREE.Vector3(-7.5, -0.6, 0),
    new THREE.Vector3(-4.5,  0.9, -1.2),
    new THREE.Vector3(-1.5, -0.7,  0.8),
    new THREE.Vector3( 1.5,  0.8, -0.8),
    new THREE.Vector3( 4.5, -0.5,  1.0),
    new THREE.Vector3( 7.5,  0.6, 0),
  ]), [])
}

function Tube({ curve }) {
  const geo = useMemo(() => new THREE.TubeGeometry(curve, 220, 0.055, 10, false), [curve])
  return (
    <mesh geometry={geo}>
      <meshStandardMaterial color="#2e6ee3" emissive="#2e6ee3" emissiveIntensity={0.35} transparent opacity={0.5} roughness={0.4} metalness={0.6}/>
    </mesh>
  )
}

// Step rings along the path — the "iFlow steps" the packet passes through.
function StepRings({ curve }) {
  const STOPS = [0.12, 0.3, 0.5, 0.7, 0.88]
  const COLORS = ['#4f8ff7', '#2f6fe0', '#8db8f0', '#3d82d6', '#6ea3e8']
  const refs = useRef([])
  const rings = useMemo(() => STOPS.map((t, i) => {
    const pos = curve.getPoint(t)
    const tangent = curve.getTangent(t)
    const lookAt = pos.clone().add(tangent)
    return { pos, lookAt, color: COLORS[i], key: i }
  }), [curve])
  useFrame(({ clock }) => {
    refs.current.forEach((m, i) => {
      if (!m) return
      m.rotation.z = clock.elapsedTime * (0.4 + i * 0.12)   // each ring spins at its own rate
      const s = 1 + Math.sin(clock.elapsedTime * 2 + i) * 0.08
      m.scale.setScalar(s)
    })
  })
  return rings.map((r, i) => (
    <group key={r.key} position={r.pos} onUpdate={g => g.lookAt(r.lookAt)}>
      <mesh ref={el => (refs.current[i] = el)}>
        <torusGeometry args={[0.34, 0.035, 12, 48]}/>
        <meshStandardMaterial color={r.color} emissive={r.color} emissiveIntensity={1.4} roughness={0.3}/>
      </mesh>
    </group>
  ))
}

// The message packet: a glowing core + halo + short trail, looping along the curve.
function Packet({ curve }) {
  const core = useRef()
  const halo = useRef()
  const light = useRef()
  const trail = useRef([])
  const TRAIL_N = 7

  useFrame(({ clock }) => {
    const t = (clock.elapsedTime * 0.085) % 1
    const p = curve.getPoint(t)
    core.current?.position.copy(p)
    halo.current?.position.copy(p)
    light.current?.position.copy(p)
    const pulse = 1 + Math.sin(clock.elapsedTime * 5) * 0.12
    halo.current?.scale.setScalar(pulse)
    for (let i = 0; i < TRAIL_N; i++) {
      const m = trail.current[i]
      if (!m) continue
      const tt = (t - (i + 1) * 0.012 + 1) % 1
      m.position.copy(curve.getPoint(tt))
      m.material.opacity = 0.45 * (1 - i / TRAIL_N)
      const s = 0.085 * (1 - i / (TRAIL_N + 2))
      m.scale.setScalar(s / 0.085)
    }
  })

  return (
    <group>
      <mesh ref={core}>
        <sphereGeometry args={[0.11, 24, 24]}/>
        <meshStandardMaterial color="#f0c896" emissive="#4f8ff7" emissiveIntensity={3.2}/>
      </mesh>
      <mesh ref={halo}>
        <sphereGeometry args={[0.2, 24, 24]}/>
        <meshBasicMaterial color="#4f8ff7" transparent opacity={0.22} blending={THREE.AdditiveBlending} depthWrite={false}/>
      </mesh>
      {Array.from({ length: TRAIL_N }).map((_, i) => (
        <mesh key={i} ref={el => (trail.current[i] = el)}>
          <sphereGeometry args={[0.085, 12, 12]}/>
          <meshBasicMaterial color="#4f8ff7" transparent opacity={0.3} blending={THREE.AdditiveBlending} depthWrite={false}/>
        </mesh>
      ))}
      <pointLight ref={light} color="#4f8ff7" intensity={2.4} distance={3.2}/>
    </group>
  )
}

// Ambient dust particles for depth.
function Dust() {
  const ref = useRef()
  const positions = useMemo(() => {
    const arr = new Float32Array(420 * 3)
    for (let i = 0; i < 420; i++) {
      arr[i * 3]     = (Math.random() - 0.5) * 18
      arr[i * 3 + 1] = (Math.random() - 0.5) * 7
      arr[i * 3 + 2] = (Math.random() - 0.5) * 6 - 1
    }
    return arr
  }, [])
  useFrame(({ clock }) => { if (ref.current) ref.current.rotation.y = clock.elapsedTime * 0.012 })
  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={positions.length / 3} array={positions} itemSize={3}/>
      </bufferGeometry>
      <pointsMaterial size={0.025} color="#4f8ff7" transparent opacity={0.4} sizeAttenuation/>
    </points>
  )
}

// Subtle camera parallax following the mouse.
function Rig() {
  const { camera, pointer } = useThree()
  useFrame(() => {
    camera.position.x += (pointer.x * 0.7 - camera.position.x) * 0.04
    camera.position.y += (pointer.y * 0.4 - camera.position.y) * 0.04
    camera.lookAt(0, 0, 0)
  })
  return null
}

// Drives the pipeline off scroll: it sinks, tilts, rotates and the packet
// path speeds up as you go down the page.
function ScrollDrift({ scrollMV, children }) {
  const g = useRef()
  useFrame((state) => {
    const v = scrollMV?.get?.() ?? 0
    const k = Math.min(v / (window.innerHeight || 900), 1.6)
    if (g.current) {
      g.current.position.y = -k * 2.4
      g.current.position.z = -k * 1.2
      g.current.rotation.z = -k * 0.16
      g.current.rotation.y = Math.sin(k * 1.4) * 0.22
      g.current.rotation.x = k * 0.08
    }
  })
  return <group ref={g}>{children}</group>
}

export default function PipelineHero({ scrollMV }) {
  const curve = usePipeCurve()
  return (
    <Canvas
      dpr={[1, 1.8]}
      camera={{ position: [0, 0, 6.4], fov: 48 }}
      gl={{ antialias: true, alpha: true }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <fog attach="fog" args={['#0a0f1c', 7.5, 14]}/>
      <ambientLight intensity={0.35}/>
      <directionalLight position={[4, 6, 5]} intensity={0.7} color="#74a8fa"/>
      <LiquidBackdrop/>
      <ScrollDrift scrollMV={scrollMV}>
        <Tube curve={curve}/>
        <StepRings curve={curve}/>
        <Packet curve={curve}/>
        <Dust/>
      </ScrollDrift>
      <Rig/>
    </Canvas>
  )
}

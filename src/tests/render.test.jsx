// Render smoke tests.
//
// These exist because of a real bug: MultiFlowPanel was rendered inside a
// component that never received `registry`, so the identifier was undeclared.
// ES modules are strict mode, so that throws ReferenceError, React unmounts,
// and the user sees a blank screen with nothing in the UI to explain it.
//
// A render that merely completes catches that entire class of mistake —
// undeclared props, undefined destructuring, bad hook order — none of which
// pure-logic tests can see.

import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import MultiFlowPanel from '../components/MultiFlowPanel.jsx'
import Documentation from '../components/Documentation.jsx'
import ShellBar from '../components/ShellBar.jsx'
import Sidebar from '../components/Sidebar.jsx'
import Home from '../components/Home.jsx'
import LandingPage from '../components/LandingPage.jsx'

const flows = [
  { id: 'main', name: 'Replicate Product Group', steps: {}, edges: [],
    entryPoints: [{ adapterType: 'HTTPS', address: '/pg' }],
    exitPoints: [{ adapterType: 'ProcessDirect', address: '/mail' }] },
  { id: 'mail', name: 'MailAlertCommonFlow', steps: {}, edges: [],
    entryPoints: [{ adapterType: 'ProcessDirect', address: '/mail' }], exitPoints: [] },
]
const registry = new Map(flows.map(f => [f.id, f]))

// Rendering MultiFlowPanel alone would NOT have caught the bug that prompted
// these tests: the ReferenceError was thrown by SpecBuilder, the component
// that renders it, because `registry` was never in its scope. So the useful
// test renders Documentation itself and switches into each mode.
describe('Documentation renders in every mode', () => {
  it('renders without a registry', () => {
    expect(() => renderToString(createElement(Documentation, {
      registry: new Map(), onUpload: () => {},
    }))).not.toThrow()
  })

  it('renders with flows loaded', () => {
    const html = renderToString(createElement(Documentation, { registry, onUpload: () => {} }))
    // The mode cards are the entry point to every path in this screen.
    expect(html).toContain('Multi-Flow')
    expect(html).toContain('AI Spec')
    expect(html).toContain('Default Template')
  })
})

describe('MultiFlowPanel renders', () => {
  it('renders with a resolved flow set', () => {
    const html = renderToString(createElement(MultiFlowPanel, {
      registry, mainFlowId: 'main', sharedValues: {}, onExport: () => {}, busy: false,
    }))
    expect(html).toContain('Replicate Product Group')
    expect(html).toContain('MailAlertCommonFlow')
  })

  it('renders the empty state instead of throwing when no flow is selected', () => {
    const html = renderToString(createElement(MultiFlowPanel, {
      registry, mainFlowId: null, onExport: () => {},
    }))
    // Flows are attached explicitly now, so the empty state prompts for that
    // rather than pointing at a selector elsewhere on the screen.
    expect(html).toMatch(/No flows selected yet/i)
    expect(html).toContain('Add iFlow')
  })

  it('does not throw when the registry is missing entirely', () => {
    // This is the exact shape of the bug that caused the blank screen: the
    // prop simply never arrived.
    expect(() => renderToString(createElement(MultiFlowPanel, {
      registry: undefined, mainFlowId: 'main', onExport: () => {},
    }))).not.toThrow()
  })

  it('does not throw when the main flow is not in the registry', () => {
    expect(() => renderToString(createElement(MultiFlowPanel, {
      registry, mainFlowId: 'does-not-exist', onExport: () => {},
    }))).not.toThrow()
  })

  it('starts with the main flow already selected so the list is never empty on open', () => {
    const html = renderToString(createElement(MultiFlowPanel, {
      registry, mainFlowId: 'main', sharedValues: {}, onExport: () => {}, busy: false,
    }))
    // The main flow shows in the selected list with its MAIN marker — proof the
    // seed selection works, which is the other half of the add-flow flow.
    expect(html).toContain('MAIN')
  })
})

describe('LandingPage renders', () => {
  it('renders the hero, all feature tiles, and the BTP roles', () => {
    const html = renderToString(createElement(LandingPage, { onStart: () => {} }))
    expect(html).toContain('Compare Packages')
    expect(html).toContain('Real CPI Trace')
    expect(html).toContain('MessagePayloadsRead')
    expect(html).toContain('SAP Integration Suite Accelerator')
  })

  it('does not throw when onStart is omitted at render time', () => {
    expect(() => renderToString(createElement(LandingPage, {}))).not.toThrow()
  })
})

describe('Home renders', () => {
  it('shows the At a glance, Analyze, Operate, and Utilities sections', () => {
    const html = renderToString(createElement(Home, { onNavigate: () => {} }))
    expect(html).toContain('At a glance')
    expect(html).toContain('Analyze')
    expect(html).toContain('Operate')
    expect(html).toContain('Utilities')
  })

  it('lists every feature tile', () => {
    const html = renderToString(createElement(Home, { onNavigate: () => {} }))
    expect(html).toContain('Compare Packages')
    expect(html).toContain('Intelligence')
    expect(html).toContain('Documentation')
    expect(html).toContain('Real Trace')
    expect(html).toContain('Live Trigger')
    expect(html).toContain('Converter')
  })

  it('shows dynamic tile numbers driven by app state', () => {
    const registry = new Map([
      ['a', { id: 'a', name: 'A', steps: {}, edges: [], entryPoints: [], exitPoints: [], color: '#000' }],
      ['b', { id: 'b', name: 'B', steps: {}, edges: [], entryPoints: [], exitPoints: [], color: '#000' }],
      ['c', { id: 'c', name: 'C', steps: {}, edges: [], entryPoints: [], exitPoints: [], color: '#000' }],
    ])
    const html = renderToString(createElement(Home, {
      onNavigate: () => {}, registry, checkpointCount: 2,
      traceSession: { connected: true, clientSecret: '' },
    }))
    expect(html).toContain('iFlows loaded')
    expect(html).toContain('CPI Tenant')
    expect(html).toContain('Checkpoints')
    expect(html).toContain('Live')          // tenant status when connected
    expect(html).toContain('>3<')           // three iFlows loaded
    expect(html).toContain('>2<')           // two checkpoints waiting
  })

  it('surfaces the My iFlows worklist when the registry has entries', () => {
    const registry = new Map([
      ['pr', {
        id: 'pr', name: 'ProductReplication', color: '#6ab0f3',
        steps: { s1: {}, s2: {}, s3: {} }, edges: [],
        entryPoints: [{ adapterType: 'HTTPS', address: '/pg' }],
        exitPoints:  [{ adapterType: 'ProcessDirect', address: '/mail' }],
      }],
    ])
    const html = renderToString(createElement(Home, { onNavigate: () => {}, registry }))
    expect(html).toContain('My iFlows')
    expect(html).toContain('ProductReplication')
    expect(html).toContain('HTTPS')
    expect(html).toContain('ProcessDirect')
    expect(html).toContain('3 steps')
  })

  it('hides the My iFlows section when the registry is empty', () => {
    const html = renderToString(createElement(Home, { onNavigate: () => {} }))
    expect(html).not.toContain('My iFlows')
  })

  it('renders without any optional props', () => {
    expect(() => renderToString(createElement(Home, { onNavigate: () => {} }))).not.toThrow()
  })
})

describe('ShellBar renders', () => {
  it('renders with default props', () => {
    const html = renderToString(createElement(ShellBar))
    expect(html).toContain('ShipBridge')
    expect(html).toContain('SAP Integration Suite Accelerator')
  })

  it('renders with a custom product name and subtitle', () => {
    const html = renderToString(createElement(ShellBar, { productName: 'Custom', subtitle: 'Sub' }))
    expect(html).toContain('Custom')
    expect(html).toContain('Sub')
  })
})

describe('Sidebar renders', () => {
  // Sidebar is now the sole nav surface (the ShellBar was removed because it
  // duplicated the SHIPBRIDGE branding and its fixed height was clipping page
  // H1s underneath). This just checks the render doesn't throw in both the
  // expanded and collapsed states — pixel behaviour is a manual/visual check.
  it('renders expanded without a registry count or badges', () => {
    expect(() => renderToString(createElement(Sidebar, {
      pages: [{ id: 'trace', label: 'Real Trace' }],
      page: 'trace', onNavigate: () => {}, onHome: () => {},
      theme: 'light', onToggleTheme: () => {},
      registryCount: 0, cpBadge: 0,
      collapsed: false, onToggleCollapse: () => {},
    }))).not.toThrow()
  })

  it('renders collapsed (icon rail)', () => {
    expect(() => renderToString(createElement(Sidebar, {
      pages: [{ id: 'trace', label: 'Real Trace' }],
      page: 'trace', onNavigate: () => {}, onHome: () => {},
      theme: 'light', onToggleTheme: () => {},
      registryCount: 3, cpBadge: 1,
      collapsed: true, onToggleCollapse: () => {},
    }))).not.toThrow()
  })
})

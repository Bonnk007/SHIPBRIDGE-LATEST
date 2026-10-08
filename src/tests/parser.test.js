// Direct tests for src/lib/parser.js.
//
// This file exists because the module every other part of ShipBridge is built
// on — parseIFlw, getProps, parseCMTable, normalizePDAddress — had no direct
// coverage, and four real bugs were living in that blind spot. Each block below
// names the bug it pins down, so a regression says what broke rather than just
// which assertion failed.

import { describe, it, expect } from 'vitest'
import { parseIFlw, parseCMTable, normalizePDAddress, pdKey, resolveKind } from '../lib/parser.js'

// ── Fixture: a realistic multi-process iFlow ───────────────────────────────
// Main process with a Content Modifier, a Groovy step and a ProcessDirect
// receiver, plus the exception subprocess nearly every production flow has —
// and that subprocess CONTAINS a Groovy step, which is what used to make the
// subprocess itself parse as a GroovyScript.
const prop = (k, v) => `<ifl:property><key>${k}</key><value>${v}</value></ifl:property>`
const ext = (...props) => `<bpmn2:extensionElements>${props.join('')}</bpmn2:extensionElements>`

const IFLW = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL"
                   xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd">
  <bpmn2:collaboration id="Collab_1">
    <bpmn2:participant id="Participant_Process_1" name="Integration Process" ifl:type="IntegrationProcess" processRef="Process_1">
      ${ext(prop('ifl:type', 'IntegrationProcess'))}
    </bpmn2:participant>
    <bpmn2:participant id="Participant_Sender" name="Sender" ifl:type="EndpointSender"/>
    <bpmn2:participant id="Participant_PD" name="OrderSplitTarget" ifl:type="EndpointRecevier"/>

    <bpmn2:messageFlow id="MessageFlow_In" name="HTTPS" sourceRef="Participant_Sender" targetRef="StartEvent_1">
      ${ext(prop('ComponentType', 'HTTPS'), prop('direction', 'Sender'), prop('urlPath', '/OrderCreate'))}
    </bpmn2:messageFlow>

    <!-- A ProcessDirect receiver whose ComponentType IS declared. -->
    <bpmn2:messageFlow id="MessageFlow_PD" name="ToOrderSplit" sourceRef="CallActivity_PD" targetRef="Participant_PD">
      ${ext(prop('ComponentType', 'ProcessDirect'), prop('direction', 'Receiver'), prop('address', '/Orders_Split'))}
    </bpmn2:messageFlow>

    <!-- A message flow with NO ComponentType. This used to take its own NAME
         ("SomeUnlabelledFlow") as its adapter type. -->
    <bpmn2:messageFlow id="MessageFlow_NoType" name="SomeUnlabelledFlow" sourceRef="CallActivity_CM" targetRef="Participant_PD">
      ${ext(prop('direction', 'Receiver'), prop('address', '/Nowhere'))}
    </bpmn2:messageFlow>
  </bpmn2:collaboration>

  <bpmn2:process id="Process_1" name="Main Process">
    <bpmn2:startEvent id="StartEvent_1" name="Start">
      ${ext(prop('activityType', 'StartEvent'))}
    </bpmn2:startEvent>

    <bpmn2:callActivity id="CallActivity_CM" name="Set Order Headers">
      ${ext(prop('activityType', 'ContentModifier'),
            prop('headerTable', '&lt;row&gt;&lt;cell id="Name"&gt;OrderId&lt;/cell&gt;&lt;cell id="Type"&gt;xpath&lt;/cell&gt;&lt;cell id="Value"&gt;//Order/Id&lt;/cell&gt;&lt;/row&gt;'))}
    </bpmn2:callActivity>

    <bpmn2:callActivity id="CallActivity_Script" name="Enrich Payload">
      ${ext(prop('activityType', 'Script'), prop('script', 'enrich.groovy'))}
    </bpmn2:callActivity>

    <bpmn2:callActivity id="CallActivity_PD" name="Call Order Split">
      ${ext(prop('activityType', 'ExternalCall'))}
    </bpmn2:callActivity>

    <!-- THE REGRESSION CASE: a subprocess that contains a Groovy step. -->
    <bpmn2:subProcess id="SubProcess_Error" name="Exception Subprocess">
      ${ext(prop('activityType', 'ErrorEventSubProcessTemplate'))}
      <bpmn2:startEvent id="ErrorStart_1" name="Error Start">
        ${ext(prop('activityType', 'ErrorStartEvent'))}
      </bpmn2:startEvent>
      <bpmn2:callActivity id="CallActivity_ErrScript" name="Log Error">
        ${ext(prop('activityType', 'Script'), prop('script', 'logError.groovy'))}
      </bpmn2:callActivity>
    </bpmn2:subProcess>

    <bpmn2:endEvent id="EndEvent_1" name="End">
      ${ext(prop('activityType', 'EndEvent'))}
    </bpmn2:endEvent>

    <bpmn2:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="CallActivity_CM"/>
    <bpmn2:sequenceFlow id="Flow_2" sourceRef="CallActivity_CM" targetRef="CallActivity_Script"/>
    <bpmn2:sequenceFlow id="Flow_3" sourceRef="CallActivity_Script" targetRef="CallActivity_PD"/>
    <bpmn2:sequenceFlow id="Flow_4" sourceRef="CallActivity_PD" targetRef="EndEvent_1"/>
  </bpmn2:process>
</bpmn2:definitions>`

const SCRIPTS = {
  'enrich.groovy':   'def Message processData(Message m) { return m }',
  'logError.groovy': 'def Message processData(Message m) { /* log */ return m }',
}

describe('parseIFlw — step property scoping', () => {
  const flow = parseIFlw(IFLW, 'OrderCreate', SCRIPTS)

  it('parses the process name and every step', () => {
    expect(flow.name).toBe('Integration Process')
    expect(Object.keys(flow.steps).length).toBeGreaterThanOrEqual(6)
  })

  it('does NOT let a subprocess absorb its children\'s properties', () => {
    // getProps used to querySelectorAll('*') over the whole subtree, so the
    // nested Groovy step's activityType=Script won last and the subprocess was
    // reported as a GroovyScript with a bogus scriptRef.
    const sub = flow.steps['SubProcess_Error']
    expect(sub).toBeTruthy()
    expect(sub.kind).not.toBe('GroovyScript')
    expect(sub.config.scriptRef).toBeUndefined()
    expect(sub.config.script).toBeUndefined()
  })

  it('still reads the subprocess\'s own activityType', () => {
    expect(flow.steps['SubProcess_Error'].config.activityType)
      .toBe('ErrorEventSubProcessTemplate')
  })

  it('the Groovy step INSIDE the subprocess is still found, with its own script', () => {
    const inner = flow.steps['CallActivity_ErrScript']
    expect(inner.kind).toBe('GroovyScript')
    expect(inner.config.scriptRef).toBe('logError.groovy')
    expect(inner.config.preview).toContain('log')
  })

  it('a top-level Groovy step resolves its script exactly', () => {
    const s = flow.steps['CallActivity_Script']
    expect(s.kind).toBe('GroovyScript')
    expect(s.config.scriptMatch).toBe('exact')
    expect(s.config.scriptRef).toBe('enrich.groovy')
  })

  it('a Content Modifier gets only its own header table', () => {
    const cm = flow.steps['CallActivity_CM']
    expect(cm.kind).toBe('ContentModifier')
    expect(cm.config.headers).toHaveLength(1)
    expect(cm.config.headers[0]).toMatchObject({ name: 'OrderId', type: 'xpath' })
  })
})

describe('parseIFlw — adapter type resolution', () => {
  const flow = parseIFlw(IFLW, 'OrderCreate', SCRIPTS)
  const byId = Object.fromEntries((flow.adapterList || []).map(a => [a.messageFlowId, a]))

  it('reads a declared ComponentType', () => {
    expect(byId['MessageFlow_PD'].adapterType).toBe('ProcessDirect')
  })

  it('does not use the message flow NAME as the adapter type', () => {
    // Previously: props.ComponentType || props.componentType || mfName || 'HTTP'
    const a = byId['MessageFlow_NoType']
    expect(a.adapterType).not.toBe('SomeUnlabelledFlow')
    expect(a.adapterType).toBe('HTTP')
  })

  it('canonicalises ProcessDirect addresses on the way in', () => {
    expect(byId['MessageFlow_PD'].address).toBe('pd://Orders_Split')
  })
})

describe('normalizePDAddress / pdKey', () => {
  it('canonicalises every spelling to one form', () => {
    for (const input of ['Orders_Split', '/Orders_Split', 'pd:/Orders_Split',
                         'pd://Orders_Split', '  pd://Orders_Split  ', 'pd:///Orders_Split']) {
      expect(normalizePDAddress(input)).toBe('pd://Orders_Split')
    }
  })

  it('fixes the pd:/ single-slash case specifically', () => {
    // The old implementation returned 'pd:/' + s.slice(4), i.e. the input
    // unchanged, so this form never matched anything.
    expect(normalizePDAddress('pd:/Orders_Split')).toBe('pd://Orders_Split')
  })

  it('handles empty input', () => {
    for (const v of ['', null, undefined, '   ', 'pd://', '/']) {
      expect(normalizePDAddress(v)).toBe('')
    }
  })

  it('pdKey compares case- and slash-insensitively', () => {
    const forms = ['Orders_Split', '/orders_split', 'pd://ORDERS_SPLIT', 'pd:/Orders_Split/']
    const keys = forms.map(pdKey)
    expect(new Set(keys).size).toBe(1)
    expect(keys[0]).toBe('orders_split')
  })

  it('pdKey keeps distinct addresses distinct', () => {
    expect(pdKey('Orders_Split')).not.toBe(pdKey('Orders_Merge'))
  })
})

describe('parseCMTable — malformed values must not erase the table', () => {
  const row = (name, type, value) =>
    `<row><cell id="Name">${name}</cell><cell id="Type">${type}</cell><cell id="Value">${value}</cell></row>`

  it('parses a well-formed table', () => {
    const rows = parseCMTable(row('OrderId', 'xpath', '//Order/Id'))
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('OrderId')
  })

  it('recovers when a value contains a bare ampersand', () => {
    // `${property.a} & ${property.b}` is an ordinary CPI expression and used to
    // make the whole table return [] — silently losing every header for the step.
    const rows = parseCMTable(row('Combined', 'expression', '${property.a} & ${property.b}'))
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Combined')
    expect(rows[0].value).toContain('&')
  })

  it('recovers when a value contains a raw less-than', () => {
    const rows = parseCMTable(row('IsSmall', 'expression', '${header.count} < 5'))
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0].name).toBe('IsSmall')
  })

  it('keeps the other rows when one value is malformed', () => {
    const rows = parseCMTable(
      row('Good', 'constant', 'fine') +
      row('Bad', 'expression', '${a} < ${b} & ${c}') +
      row('AlsoGood', 'xpath', '//X')
    )
    expect(rows.map(r => r.name)).toEqual(expect.arrayContaining(['Good', 'Bad', 'AlsoGood']))
  })

  it('returns [] for genuinely empty input, not a thrown error', () => {
    expect(parseCMTable('')).toEqual([])
    expect(parseCMTable(null)).toEqual([])
    expect(parseCMTable('   ')).toEqual([])
  })
})

describe('resolveKind', () => {
  it('maps the activity types the parser actually emits', () => {
    expect(resolveKind('bpmn2:callActivity', { activityType: 'Script' })).toBe('GroovyScript')
    expect(resolveKind('bpmn2:callActivity', { activityType: 'ContentModifier' })).toBe('ContentModifier')
    expect(resolveKind('bpmn2:callActivity', { activityType: 'Enricher' })).toBe('ContentModifier')
    expect(resolveKind('bpmn2:callActivity', { activityType: 'Mapping' })).toBe('MessageMapping')
  })
})

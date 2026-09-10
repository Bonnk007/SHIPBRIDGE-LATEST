// Inline to avoid circular import
function normalizePDAddress(addr) {
  if (!addr) return ''
  const s = addr.trim()
  if (s.startsWith('pd://')) return s
  if (s.startsWith('pd:/'))  return 'pd:/' + s.slice(4)
  if (s.startsWith('/'))     return 'pd:/' + s
  return 'pd://' + s
}


/**
 * Auto-discover links between iFlows by matching ProcessDirect / HTTP / JMS etc.
 */
export function autoLink(registry) {
  const links = []

  registry.forEach((flowA, idA) => {
    ;(flowA.exitPoints || []).forEach(exit => {
      let matched = false
      registry.forEach((flowB, idB) => {
        if (idA === idB || matched) return
        const entry = (flowB.entryPoints || []).find(ep => matchEndpoints(exit, ep))
        if (entry) {
          links.push({
            from: idA, to: idB,
            via: exit.address,
            adapterType: exit.adapterType,
            auto: true,
            exitStepId: exit.stepId
          })
          matched = true
        }
      })
      if (!matched) {
        links.push({
          from: idA, to: null,
          via: exit.address,
          adapterType: exit.adapterType,
          auto: false,
          exitStepId: exit.stepId
        })
      }
    })
  })

  return links
}

function matchEndpoints(exit, entry) {
  if (exit.adapterType !== entry.adapterType) return false

  switch (exit.adapterType) {
    case 'ProcessDirect': {
      const a = normalizePDAddress(exit.address)
      const b = normalizePDAddress(entry.address)
      return a && b && a === b
    }

    case 'HTTP':
    case 'HTTPS':
    case 'SOAP':
    case 'REST': {
      const normA = normalizePath(exit.address)
      const normB = normalizePath(entry.address)
      return normA && normB && (normA === normB || normA.endsWith(normB) || normB.endsWith(normA))
    }

    case 'SFTP':
    case 'File': {
      const dirA = (exit.address || '').replace(/\/$/, '')
      const dirB = (entry.address || '').replace(/\/$/, '')
      return dirA && dirB && dirA === dirB
    }

    case 'JMS':
    case 'AMQP':
    case 'AS2':
      return exit.address && exit.address === entry.address

    default:
      return false
  }
}

function normalizePath(addr) {
  if (!addr) return ''
  try { return new URL(addr).pathname.replace(/\/$/, '') }
  catch { return addr.replace(/\/$/, '') }
}

export function applyManualLink(links, fromId, via, toId) {
  return links.map(l =>
    l.from === fromId && l.via === via
      ? { ...l, to: toId, auto: false, manual: true }
      : l
  )
}

// Error boundary.
//
// A React render error unmounts the whole tree, which is why a crash shows as
// a blank white screen with the real cause only visible in the browser console.
// For a tool a consultant runs in front of a client, "nothing happened" is the
// worst possible failure mode — it's indistinguishable from a hang, a bad
// build, or a broken server.
//
// This catches the error, keeps the rest of the app usable, and shows what
// actually went wrong plus a copy button, so a bug report carries the stack
// instead of "the screen went blank".

import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    this.setState({ info })
    // Keep the console trace too — it has source-mapped frames the UI doesn't.
    console.error('[ShipBridge] render error in', this.props.label || 'component', error, info)
  }

  // Reset when the caller switches to a different page, so one broken screen
  // doesn't strand the user until they reload.
  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, info: null })
    }
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children

    const detail = [
      `${this.props.label ? `Page: ${this.props.label}` : ''}`,
      `${error?.name || 'Error'}: ${error?.message || String(error)}`,
      error?.stack || '',
      info?.componentStack || '',
    ].filter(Boolean).join('\n\n')

    return (
      <div style={{ padding: '28px 24px', maxWidth: 800 }}>
        <div style={{
          border: '1px solid rgba(185,28,28,.35)', background: 'var(--red-bg)',
          borderRadius: 12, padding: '18px 20px',
        }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--red)', marginBottom: 6 }}>
            This screen hit an error
          </div>
          <p style={{ fontSize: 14, color: 'var(--text2)', lineHeight: 1.7, margin: '0 0 12px' }}>
            The rest of the app still works — switch to another page and back, or reload.
            The details below identify the cause; send them along if you report this.
          </p>

          <div className="mono" style={{
            fontSize: 13, color: 'var(--text2)', background: 'var(--bg3)',
            border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto',
          }}>
            {detail}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-ghost btn-sm"
              onClick={() => navigator.clipboard?.writeText(detail)}>Copy details</button>
            <button className="btn btn-ghost btn-sm"
              onClick={() => this.setState({ error: null, info: null })}>Try again</button>
            <button className="btn btn-ghost btn-sm"
              onClick={() => window.location.reload()}>Reload app</button>
          </div>
        </div>
      </div>
    )
  }
}

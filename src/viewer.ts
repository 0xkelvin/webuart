import './viewer.css'

type ViewerStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

declare global {
  interface Window {
    __ONLINE_UART_SHARE_WS_BASE__?: string
    __ONLINE_UART_SHARE_API_BASE__?: string
  }
}

const viewerRoot = document.querySelector<HTMLDivElement>('#viewerApp')
if (!viewerRoot) {
  throw new Error('Failed to initialize viewer root')
}

const params = new URLSearchParams(window.location.search)
const sessionId = params.get('s') ?? ''

const isLocalHostName = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'

const getShareConfigMeta = (name: string) => {
  const content = document
    .querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
    ?.getAttribute('content')
    ?.trim()
  return content && content.length > 0 ? content : null
}

const getShareApiBase = () => {
  if (window.__ONLINE_UART_SHARE_API_BASE__) {
    return window.__ONLINE_UART_SHARE_API_BASE__
  }
  const metaApiBase = getShareConfigMeta('online-uart-share-api-base')
  if (metaApiBase) {
    return metaApiBase
  }
  return isLocalHostName(window.location.hostname)
    ? 'http://localhost:8787'
    : window.location.origin
}

const getShareWsBase = () => {
  if (window.__ONLINE_UART_SHARE_WS_BASE__) {
    return window.__ONLINE_UART_SHARE_WS_BASE__
  }
  const metaWsBase = getShareConfigMeta('online-uart-share-ws-base')
  if (metaWsBase) {
    return metaWsBase
  }
  const apiBase = getShareApiBase()
  if (apiBase.startsWith('https://')) {
    return `wss://${apiBase.slice('https://'.length)}`
  }
  if (apiBase.startsWith('http://')) {
    return `ws://${apiBase.slice('http://'.length)}`
  }
  return apiBase
}

const renderShell = () => {
  viewerRoot.innerHTML = `
    <main class="viewer">
      <header class="viewerHeader">
        <div>
          <h1 class="viewerTitle">Shared UART Session</h1>
          <p class="viewerStatus" id="viewerStatusText"></p>
        </div>
        <div class="viewerHint">Read-only viewer</div>
      </header>
      <pre class="viewerTerminal" id="viewerTerminal" aria-live="polite"></pre>
    </main>
  `
}

const updateStatus = (status: ViewerStatus, extra = '') => {
  const statusTextEl = document.querySelector<HTMLElement>('#viewerStatusText')
  if (!statusTextEl) {
    return
  }

  const label =
    status === 'connecting'
      ? 'Connecting'
      : status === 'connected'
        ? 'Connected'
        : status === 'disconnected'
          ? 'Disconnected'
          : 'Error'

  statusTextEl.innerHTML = `<span class="viewerStatusDot ${status}"></span>${label}${extra ? ` - ${extra}` : ''}`
}

const appendTerminal = (text: string) => {
  const terminal = document.querySelector<HTMLElement>('#viewerTerminal')
  if (!terminal) {
    return
  }
  terminal.textContent += text
  terminal.scrollTop = terminal.scrollHeight
}

renderShell()

if (!sessionId) {
  updateStatus('error', 'missing session id')
  appendTerminal('[Viewer error] Missing share session id in URL.\n')
} else {
  updateStatus('connecting')

  const wsUrl = `${getShareWsBase()}/api/sessions/${encodeURIComponent(sessionId)}/ws?role=viewer`
  const ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    updateStatus('connected')
  }

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(String(event.data)) as {
        type?: string
        payload?: string
        message?: string
      }
      if (message.type === 'history' && message.payload) {
        appendTerminal(message.payload)
        return
      }
      if (message.type === 'data' && message.payload) {
        appendTerminal(message.payload)
        return
      }
      if (message.type === 'session_closed') {
        updateStatus('disconnected', 'session closed by host')
        return
      }
      if (message.type === 'error') {
        updateStatus('error', message.message ?? 'unknown error')
      }
    } catch {
      // Ignore malformed relay messages.
    }
  }

  ws.onclose = () => {
    updateStatus('disconnected')
  }

  ws.onerror = () => {
    updateStatus('error', 'connection failed')
  }
}

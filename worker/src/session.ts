interface SessionMessage {
  type: string
  payload?: string
  token?: string
  newToken?: string
  code?: string
  message?: string
}

interface SessionState {
  hostToken: string
  hostAuthenticated: boolean
  buffer: string[]
  bufferBytes: number
  totalBytes: number
  lastHostMessage: number
  createdAt: number
}

const MAX_BUFFER_BYTES = 256 * 1024
const MAX_SESSION_BYTES = 512 * 1024
const MAX_SESSION_DURATION_MS = 30 * 60 * 1000
const INACTIVITY_TIMEOUT_MS = 60 * 1000
const ALARM_INTERVAL_MS = 30 * 1000

export class SessionRoom implements DurableObject {
  private sessionState: SessionState | null = null

  constructor(
    private state: DurableObjectState,
    private env: unknown,
  ) {}

  private async getSessionState(): Promise<SessionState | null> {
    if (this.sessionState) {
      return this.sessionState
    }
    this.sessionState = (await this.state.storage.get<SessionState>('session')) ?? null
    return this.sessionState
  }

  private async saveSessionState(): Promise<void> {
    if (!this.sessionState) {
      return
    }
    await this.state.storage.put('session', this.sessionState)
  }

  private getHostWs(): WebSocket | null {
    const sockets = this.state.getWebSockets('host')
    return sockets.length > 0 ? sockets[0] : null
  }

  private getViewerWs(): WebSocket | null {
    const sockets = this.state.getWebSockets('viewer')
    return sockets.length > 0 ? sockets[0] : null
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/init' && request.method === 'POST') {
      const body = (await request.json()) as { hostToken: string }
      this.sessionState = {
        hostToken: body.hostToken,
        hostAuthenticated: false,
        buffer: [],
        bufferBytes: 0,
        totalBytes: 0,
        lastHostMessage: Date.now(),
        createdAt: Date.now(),
      }
      await this.saveSessionState()
      this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
      return new Response('ok')
    }

    const role = url.searchParams.get('role')
    if (role === 'host') {
      return this.handleHostUpgrade()
    }
    if (role === 'viewer') {
      return this.handleViewerUpgrade()
    }

    return new Response('Bad request', { status: 400 })
  }

  private async handleHostUpgrade(): Promise<Response> {
    const session = await this.getSessionState()
    if (!session) {
      return this.wsError('SESSION_NOT_FOUND', 'Session not initialized')
    }
    if (this.getHostWs()) {
      return this.wsError('HOST_EXISTS', 'Host already connected')
    }

    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1], ['host'])
    session.hostAuthenticated = false
    session.lastHostMessage = Date.now()
    await this.saveSessionState()

    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private async handleViewerUpgrade(): Promise<Response> {
    const session = await this.getSessionState()
    if (!session) {
      return this.wsError('SESSION_NOT_FOUND', 'Session not found')
    }

    const oldViewer = this.getViewerWs()
    if (oldViewer) {
      this.sendTo(oldViewer, { type: 'session_closed' })
      try {
        oldViewer.close(1000, 'Replaced by new viewer')
      } catch {
        // Ignore close errors.
      }
    }

    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1], ['viewer'])

    const history = session.buffer.join('')
    this.sendTo(pair[1], { type: 'history', payload: history })

    const hostWs = this.getHostWs()
    if (hostWs) {
      this.sendTo(hostWs, { type: 'viewer_connected' })
    }

    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') {
      return
    }

    let parsed: SessionMessage
    try {
      parsed = JSON.parse(message) as SessionMessage
    } catch {
      return
    }

    const tags = this.state.getTags(ws)
    const isHost = tags.includes('host')
    if (!isHost) {
      return
    }

    const session = await this.getSessionState()
    if (!session) {
      return
    }

    if (!session.hostAuthenticated) {
      if (parsed.type === 'auth' && parsed.token) {
        if (parsed.token !== session.hostToken) {
          this.sendTo(ws, { type: 'error', code: 'INVALID_TOKEN', message: 'Invalid host token' })
          try {
            ws.close(1008, 'Invalid token')
          } catch {
            // Ignore close errors.
          }
          return
        }

        const newToken = crypto.randomUUID()
        session.hostToken = newToken
        session.hostAuthenticated = true
        session.lastHostMessage = Date.now()
        await this.saveSessionState()
        this.sendTo(ws, { type: 'auth_ok', newToken })
      }
      return
    }

    session.lastHostMessage = Date.now()

    if (parsed.type === 'ping') {
      this.sendTo(ws, { type: 'pong' })
      await this.saveSessionState()
      return
    }

    if (parsed.type !== 'data' || !parsed.payload) {
      return
    }

    const payloadBytes = parsed.payload.length
    session.totalBytes += payloadBytes
    if (session.totalBytes > MAX_SESSION_BYTES) {
      this.sendTo(ws, {
        type: 'error',
        code: 'LIMIT_REACHED',
        message: 'Session data cap exceeded',
      })
      await this.closeSession()
      return
    }

    session.buffer.push(parsed.payload)
    session.bufferBytes += payloadBytes
    while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 0) {
      const removed = session.buffer.shift() as string
      session.bufferBytes -= removed.length
    }

    await this.saveSessionState()

    const viewerWs = this.getViewerWs()
    if (viewerWs) {
      this.sendTo(viewerWs, { type: 'data', payload: parsed.payload })
    }
  }

  async webSocketClose(ws: WebSocket) {
    const tags = this.state.getTags(ws)

    if (tags.includes('host')) {
      const viewerWs = this.getViewerWs()
      if (viewerWs) {
        this.sendTo(viewerWs, { type: 'session_closed' })
        try {
          viewerWs.close(1000, 'Host disconnected')
        } catch {
          // Ignore close errors.
        }
      }
      await this.state.storage.deleteAll()
      this.sessionState = null
      return
    }

    if (tags.includes('viewer')) {
      const hostWs = this.getHostWs()
      if (hostWs) {
        this.sendTo(hostWs, { type: 'viewer_disconnected' })
      }
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws)
  }

  async alarm() {
    const session = await this.getSessionState()
    if (!session) {
      return
    }

    const now = Date.now()
    if (now - session.lastHostMessage > INACTIVITY_TIMEOUT_MS) {
      await this.closeSession()
      return
    }

    if (now - session.createdAt > MAX_SESSION_DURATION_MS) {
      const hostWs = this.getHostWs()
      const viewerWs = this.getViewerWs()
      const message: SessionMessage = {
        type: 'error',
        code: 'LIMIT_REACHED',
        message: 'Maximum session duration exceeded',
      }
      if (hostWs) {
        this.sendTo(hostWs, message)
      }
      if (viewerWs) {
        this.sendTo(viewerWs, message)
      }
      await this.closeSession()
      return
    }

    if (this.getHostWs()) {
      this.state.storage.setAlarm(now + ALARM_INTERVAL_MS)
    }
  }

  private async closeSession() {
    const hostWs = this.getHostWs()
    const viewerWs = this.getViewerWs()

    if (hostWs) {
      this.sendTo(hostWs, { type: 'session_closed' })
      try {
        hostWs.close(1000, 'Session closed')
      } catch {
        // Ignore close errors.
      }
    }

    if (viewerWs) {
      this.sendTo(viewerWs, { type: 'session_closed' })
      try {
        viewerWs.close(1000, 'Session closed')
      } catch {
        // Ignore close errors.
      }
    }

    await this.state.storage.deleteAll()
    this.sessionState = null
  }

  private sendTo(ws: WebSocket, message: SessionMessage) {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // Ignore sends to closed sockets.
    }
  }

  private wsError(code: string, message: string): Response {
    return new Response(JSON.stringify({ error: message, code }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }
}

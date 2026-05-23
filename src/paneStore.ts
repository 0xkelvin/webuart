export type PaneId = string

type PaneLike = {
  id: PaneId
  isConnected: boolean
  connectedBaudRate: number | null
  connectedUartName: string | null
  statusMessage: string
  activeTimerCommandId: string | null
  activeTimerHandle: number | null
  timerSendBusy: boolean
  quickCommands: Array<{ id: string; label: string }>
  timerCommands: Array<{ id: string; label: string }>
  shareStatus: 'idle' | 'creating' | 'sharing' | 'error'
  shareViewerState: 'waiting' | 'connected'
  shareSessionId: string | null
  shareUrl: string | null
  shareError: string | null
  shareSocket: WebSocket | null
  sharePingHandle: number | null
}

type PaneMutator<TPane extends PaneLike> = (pane: TPane) => void

type ConnectedStateInput = {
  baudRate: number
  uartName: string
  statusMessage?: string
}

type DisconnectedStateInput = {
  statusMessage?: string
}

type ConnectFailedStateInput = {
  statusMessage: string
}

type TimerStartedStateInput = {
  commandId: string
  handle: number
  statusMessage?: string
}

type TimerStoppedStateInput = {
  statusMessage?: string
}

type TimerBusyStateInput = {
  busy: boolean
}

type ShareStatusMessageInput = {
  statusMessage?: string
}

type ShareSessionInput = {
  sessionId: string
  shareUrl: string
  shareSocket: WebSocket
  statusMessage?: string
}

type ShareViewerStateInput = {
  viewerState: 'waiting' | 'connected'
  statusMessage?: string
}

type ShareErrorStateInput = {
  error: string
  statusMessage?: string
  clearSession?: boolean
}

export const createPaneStore = <TPane extends PaneLike>() => {
  const panes = new Map<PaneId, TPane>()

  return {
    get: (paneId: PaneId) => panes.get(paneId),
    has: (paneId: PaneId) => panes.has(paneId),
    set: (paneId: PaneId, pane: TPane) => {
      panes.set(paneId, pane)
    },
    delete: (paneId: PaneId) => panes.delete(paneId),
    values: () => panes.values(),
    entries: () => panes.entries(),
    mutate: (paneId: PaneId, mutator: PaneMutator<TPane>) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      mutator(pane)
      return pane
    },
    markConnected: (paneId: PaneId, input: ConnectedStateInput) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.isConnected = true
      pane.connectedBaudRate = input.baudRate
      pane.connectedUartName = input.uartName
      pane.statusMessage = input.statusMessage ?? ''
      return pane
    },
    markDisconnected: (paneId: PaneId, input?: DisconnectedStateInput) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.isConnected = false
      pane.connectedBaudRate = null
      pane.connectedUartName = null
      pane.statusMessage = input?.statusMessage ?? ''
      return pane
    },
    markConnectFailed: (paneId: PaneId, input: ConnectFailedStateInput) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.isConnected = false
      pane.connectedBaudRate = null
      pane.connectedUartName = null
      pane.statusMessage = input.statusMessage
      return pane
    },
    markTimerStarted: (paneId: PaneId, input: TimerStartedStateInput) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.activeTimerCommandId = input.commandId
      pane.activeTimerHandle = input.handle
      pane.timerSendBusy = false
      if (typeof input.statusMessage === 'string') {
        pane.statusMessage = input.statusMessage
      }
      return pane
    },
    markTimerStopped: (paneId: PaneId, input?: TimerStoppedStateInput) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.activeTimerHandle = null
      pane.activeTimerCommandId = null
      pane.timerSendBusy = false
      if (typeof input?.statusMessage === 'string') {
        pane.statusMessage = input.statusMessage
      }
      return pane
    },
    setTimerSendBusy: (paneId: PaneId, input: TimerBusyStateInput) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.timerSendBusy = input.busy
      return pane
    },
    addQuickCommand: (paneId: PaneId, command: TPane['quickCommands'][number]) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.quickCommands.push(command)
      return pane
    },
    replaceQuickCommand: (
      paneId: PaneId,
      commandId: string,
      command: TPane['quickCommands'][number],
    ) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      const commandIndex = pane.quickCommands.findIndex((item) => item.id === commandId)
      if (commandIndex < 0) {
        return null
      }
      pane.quickCommands[commandIndex] = command
      return pane
    },
    removeQuickCommand: (paneId: PaneId, commandId: string) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      const commandIndex = pane.quickCommands.findIndex((item) => item.id === commandId)
      if (commandIndex < 0) {
        return null
      }
      const [removed] = pane.quickCommands.splice(commandIndex, 1)
      return removed
    },
    addTimerCommand: (paneId: PaneId, command: TPane['timerCommands'][number]) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.timerCommands.push(command)
      return pane
    },
    replaceTimerCommand: (
      paneId: PaneId,
      commandId: string,
      command: TPane['timerCommands'][number],
    ) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      const commandIndex = pane.timerCommands.findIndex((item) => item.id === commandId)
      if (commandIndex < 0) {
        return null
      }
      pane.timerCommands[commandIndex] = command
      return pane
    },
    removeTimerCommand: (paneId: PaneId, commandId: string) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      const commandIndex = pane.timerCommands.findIndex((item) => item.id === commandId)
      if (commandIndex < 0) {
        return null
      }
      const [removed] = pane.timerCommands.splice(commandIndex, 1)
      return removed
    },
    markShareCreating: (paneId: PaneId, input?: ShareStatusMessageInput) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.shareStatus = 'creating'
      pane.shareViewerState = 'waiting'
      pane.shareSessionId = null
      pane.shareUrl = null
      pane.shareError = null
      if (typeof input?.statusMessage === 'string') {
        pane.statusMessage = input.statusMessage
      }
      return pane
    },
    setShareSession: (paneId: PaneId, input: ShareSessionInput) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.shareSessionId = input.sessionId
      pane.shareUrl = input.shareUrl
      pane.shareSocket = input.shareSocket
      pane.shareStatus = 'creating'
      pane.shareViewerState = 'waiting'
      pane.shareError = null
      if (typeof input.statusMessage === 'string') {
        pane.statusMessage = input.statusMessage
      }
      return pane
    },
    markShareReady: (paneId: PaneId, input?: ShareStatusMessageInput) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.shareStatus = 'sharing'
      pane.shareViewerState = 'waiting'
      pane.shareError = null
      if (typeof input?.statusMessage === 'string') {
        pane.statusMessage = input.statusMessage
      }
      return pane
    },
    setShareViewerState: (paneId: PaneId, input: ShareViewerStateInput) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.shareViewerState = input.viewerState
      if (typeof input.statusMessage === 'string') {
        pane.statusMessage = input.statusMessage
      }
      return pane
    },
    markShareError: (paneId: PaneId, input: ShareErrorStateInput) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.shareError = input.error
      pane.shareStatus = 'error'
      if (input.clearSession ?? true) {
        pane.shareSessionId = null
        pane.shareUrl = null
      }
      pane.statusMessage = input.statusMessage ?? input.error
      return pane
    },
    markShareIdle: (paneId: PaneId, input?: ShareStatusMessageInput) => {
      const pane = panes.get(paneId)
      if (!pane) {
        return null
      }
      pane.shareStatus = 'idle'
      pane.shareViewerState = 'waiting'
      pane.shareSessionId = null
      pane.shareUrl = null
      pane.shareError = null
      if (typeof input?.statusMessage === 'string') {
        pane.statusMessage = input.statusMessage
      }
      return pane
    },
    toArray: () => Array.from(panes.values()),
  }
}

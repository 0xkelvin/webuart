import { describe, expect, it } from 'vitest'
import { createPaneStore } from './paneStore'

type TestQuickCommand = { id: string; label: string; value: string }
type TestTimerCommand = { id: string; label: string; intervalMs: number }

type TestPane = {
  id: string
  isConnected: boolean
  connectedBaudRate: number | null
  connectedUartName: string | null
  statusMessage: string
  activeTimerCommandId: string | null
  activeTimerHandle: number | null
  timerSendBusy: boolean
  quickCommands: TestQuickCommand[]
  timerCommands: TestTimerCommand[]
  shareStatus: 'idle' | 'creating' | 'sharing' | 'error'
  shareViewerState: 'waiting' | 'connected'
  shareSessionId: string | null
  shareUrl: string | null
  shareError: string | null
  shareSocket: WebSocket | null
  sharePingHandle: number | null
}

const createPane = (): TestPane => ({
  id: 'pane-1',
  isConnected: false,
  connectedBaudRate: null,
  connectedUartName: null,
  statusMessage: '',
  activeTimerCommandId: null,
  activeTimerHandle: null,
  timerSendBusy: false,
  quickCommands: [],
  timerCommands: [],
  shareStatus: 'idle',
  shareViewerState: 'waiting',
  shareSessionId: null,
  shareUrl: null,
  shareError: null,
  shareSocket: null,
  sharePingHandle: null,
})

describe('paneStore', () => {
  it('handles basic set/get/delete operations', () => {
    const store = createPaneStore<TestPane>()
    const pane = createPane()

    store.set(pane.id, pane)
    expect(store.has(pane.id)).toBe(true)
    expect(store.get(pane.id)).toBe(pane)

    store.delete(pane.id)
    expect(store.has(pane.id)).toBe(false)
    expect(store.get(pane.id)).toBeUndefined()
  })

  it('applies connection transition actions', () => {
    const store = createPaneStore<TestPane>()
    const pane = createPane()
    store.set(pane.id, pane)

    store.markConnected(pane.id, {
      baudRate: 115200,
      uartName: 'uart-1',
      statusMessage: 'connected',
    })

    expect(pane.isConnected).toBe(true)
    expect(pane.connectedBaudRate).toBe(115200)
    expect(pane.connectedUartName).toBe('uart-1')
    expect(pane.statusMessage).toBe('connected')

    store.markConnectFailed(pane.id, { statusMessage: 'connect failed' })
    expect(pane.isConnected).toBe(false)
    expect(pane.connectedBaudRate).toBeNull()
    expect(pane.connectedUartName).toBeNull()
    expect(pane.statusMessage).toBe('connect failed')

    store.markDisconnected(pane.id)
    expect(pane.isConnected).toBe(false)
    expect(pane.connectedBaudRate).toBeNull()
    expect(pane.connectedUartName).toBeNull()
    expect(pane.statusMessage).toBe('')
  })

  it('applies timer runtime transitions', () => {
    const store = createPaneStore<TestPane>()
    const pane = createPane()
    store.set(pane.id, pane)

    store.markTimerStarted(pane.id, {
      commandId: 'tm-1',
      handle: 42,
      statusMessage: 'timer started',
    })

    expect(pane.activeTimerCommandId).toBe('tm-1')
    expect(pane.activeTimerHandle).toBe(42)
    expect(pane.timerSendBusy).toBe(false)
    expect(pane.statusMessage).toBe('timer started')

    store.setTimerSendBusy(pane.id, { busy: true })
    expect(pane.timerSendBusy).toBe(true)

    store.markTimerStopped(pane.id, { statusMessage: 'timer stopped' })
    expect(pane.activeTimerCommandId).toBeNull()
    expect(pane.activeTimerHandle).toBeNull()
    expect(pane.timerSendBusy).toBe(false)
    expect(pane.statusMessage).toBe('timer stopped')
  })

  it('handles quick command collection actions', () => {
    const store = createPaneStore<TestPane>()
    const pane = createPane()
    store.set(pane.id, pane)

    store.addQuickCommand(pane.id, { id: 'q1', label: 'Reset', value: 'AT+RST' })
    expect(pane.quickCommands).toHaveLength(1)

    store.replaceQuickCommand(pane.id, 'q1', { id: 'q1', label: 'Ping', value: 'AT' })
    expect(pane.quickCommands[0].label).toBe('Ping')

    const removed = store.removeQuickCommand(pane.id, 'q1')
    expect(removed?.id).toBe('q1')
    expect(pane.quickCommands).toHaveLength(0)
  })

  it('handles timer command collection actions', () => {
    const store = createPaneStore<TestPane>()
    const pane = createPane()
    store.set(pane.id, pane)

    store.addTimerCommand(pane.id, { id: 't1', label: 'Heartbeat', intervalMs: 1000 })
    expect(pane.timerCommands).toHaveLength(1)

    store.replaceTimerCommand(pane.id, 't1', {
      id: 't1',
      label: 'Fast heartbeat',
      intervalMs: 500,
    })
    expect(pane.timerCommands[0].intervalMs).toBe(500)

    const removed = store.removeTimerCommand(pane.id, 't1')
    expect(removed?.id).toBe('t1')
    expect(pane.timerCommands).toHaveLength(0)
  })

  it('applies share session transitions', () => {
    const store = createPaneStore<TestPane>()
    const pane = createPane()
    store.set(pane.id, pane)

    store.markShareCreating(pane.id, { statusMessage: 'creating' })
    expect(pane.shareStatus).toBe('creating')
    expect(pane.shareViewerState).toBe('waiting')
    expect(pane.statusMessage).toBe('creating')

    store.setShareSession(pane.id, {
      sessionId: 's-1',
      shareUrl: 'https://host/viewer.html?s=s-1',
      shareSocket: {} as WebSocket,
      statusMessage: 'authenticating',
    })
    expect(pane.shareSessionId).toBe('s-1')
    expect(pane.shareUrl).toContain('s-1')
    expect(pane.shareStatus).toBe('creating')
    expect(pane.statusMessage).toBe('authenticating')

    store.markShareReady(pane.id, { statusMessage: 'ready' })
    expect(pane.shareStatus).toBe('sharing')
    expect(pane.shareError).toBeNull()

    store.setShareViewerState(pane.id, {
      viewerState: 'connected',
      statusMessage: 'viewer connected',
    })
    expect(pane.shareViewerState).toBe('connected')
    expect(pane.statusMessage).toBe('viewer connected')

    store.markShareError(pane.id, {
      error: 'share failed',
      clearSession: false,
    })
    expect(pane.shareStatus).toBe('error')
    expect(pane.shareError).toBe('share failed')
    expect(pane.shareSessionId).toBe('s-1')

    store.markShareIdle(pane.id, { statusMessage: 'stopped' })
    expect(pane.shareStatus).toBe('idle')
    expect(pane.shareViewerState).toBe('waiting')
    expect(pane.shareSessionId).toBeNull()
    expect(pane.shareUrl).toBeNull()
    expect(pane.shareError).toBeNull()
    expect(pane.statusMessage).toBe('stopped')
  })
})

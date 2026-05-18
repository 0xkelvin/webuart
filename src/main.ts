import './style.css'

type Parity = 'none' | 'even' | 'odd'
type FlowControl = 'none' | 'hardware'
type DataBits = 7 | 8
type StopBits = 1 | 2
type SplitOrientation = 'vertical' | 'horizontal'

type UartSettings = {
  baudRate: number
  dataBits: DataBits
  stopBits: StopBits
  parity: Parity
  flowControl: FlowControl
  bufferSize: number
}

type ConnectionLock = {
  owner: string
  timestamp: number
}

type PaneState = {
  id: string
  uartName: string
  settings: UartSettings
  serialPort: SerialPort | null
  reader: ReadableStreamDefaultReader<Uint8Array> | null
  isReading: boolean
  isConnected: boolean
  connectedBaudRate: number | null
  connectedUartName: string | null
  statusMessage: string
  rxLog: string
  txInput: string
  lineEnding: '' | '\n' | '\r\n' | '\r'
  txExpanded: boolean
  autoScroll: boolean
  terminalFontRem: number
  terminalThemeId: string
}

type TerminalTheme = {
  id: string
  label: string
  bg: string
  fg: string
  border: string
}

type PaneTreeNode =
  | { kind: 'pane'; paneId: string }
  | {
      kind: 'split'
      splitId: string
      orientation: SplitOrientation
      first: PaneTreeNode
      second: PaneTreeNode
    }

declare global {
  interface Navigator {
    serial?: {
      requestPort: () => Promise<SerialPort>
    }
  }

  interface SerialPort {
    open: (options: {
      baudRate: number
      dataBits?: 7 | 8
      stopBits?: 1 | 2
      parity?: Parity
      bufferSize?: number
      flowControl?: FlowControl
    }) => Promise<void>
    close: () => Promise<void>
    readable: ReadableStream<Uint8Array> | null
    writable: WritableStream<Uint8Array> | null
  }
}

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('Failed to initialize app root')
}

app.innerHTML = `
  <main class="layout">
    <section id="firstOpenTip" class="tip card hidden" aria-hidden="true">
      <div>
        <strong>Split tip:</strong> right-click inside any pane to split vertically or horizontally. Max 6 panes.
      </div>
      <div>
        Layout persistence is planned as a premium feature.
      </div>
      <button id="dismissTipBtn" class="ghost" type="button">Got it</button>
    </section>

    <section id="splitRoot" class="splitRoot"></section>
  </main>

  <div id="paneMenu" class="paneMenu hidden" aria-hidden="true">
    <button class="menuItem" data-menu-action="split-vertical" type="button">Split vertical</button>
    <button class="menuItem" data-menu-action="split-horizontal" type="button">Split horizontal</button>
    <button class="menuItem" data-menu-action="close-pane" type="button">Close pane</button>
  </div>

  <section id="settingsPanel" class="settingsPanel hidden" aria-hidden="true">
    <div class="settingsDialog card">
      <div class="settingsHeader">
        <h2>Pane UART settings</h2>
        <button id="closeSettingsBtn" class="ghost" type="button">Close</button>
      </div>
      <div class="grid">
        <label>
          Baud rate
          <input id="baudRate" type="number" min="300" step="1" value="115200" />
        </label>
        <label>
          Data bits
          <select id="dataBits">
            <option value="8" selected>8</option>
            <option value="7">7</option>
          </select>
        </label>
        <label>
          Stop bits
          <select id="stopBits">
            <option value="1" selected>1</option>
            <option value="2">2</option>
          </select>
        </label>
        <label>
          Parity
          <select id="parity">
            <option value="none" selected>none</option>
            <option value="even">even</option>
            <option value="odd">odd</option>
          </select>
        </label>
        <label>
          Flow control
          <select id="flowControl">
            <option value="none" selected>none</option>
            <option value="hardware">hardware</option>
          </select>
        </label>
        <label>
          Buffer size
          <input id="bufferSize" type="number" min="255" step="1" value="4096" />
        </label>
      </div>
      <div class="settingsActions">
        <button id="saveSettingsBtn" class="primary" type="button">Save</button>
      </div>
    </div>
  </section>
`

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const maxLogChars = 200_000
const maxPaneCount = 6
const ansiEscapeRegex = /\u001B\[[0-?]*[ -/]*[@-~]/g
const appRoutePrefix = '/webuart'
const defaultWorkspaceName = 'uart-a'
const tipStorageKey = 'online-uart:split-tip-seen:v1'
const connectionLockPrefix = 'online-uart:pane-lock:'
const lockTtlMs = 8_000
const lockHeartbeatMs = 2_000
const minTerminalFontRem = 0.72
const maxTerminalFontRem = 1.1
const terminalFontStepRem = 0.04
const defaultTerminalFontRem = 0.86
const defaultTerminalThemeId = 'ocean'
const terminalThemes: TerminalTheme[] = [
  { id: 'ocean', label: 'Ocean', bg: '#050b14', fg: '#d7f4ff', border: '#1b3648' },
  { id: 'amber', label: 'Amber', bg: '#140f05', fg: '#ffd89b', border: '#5c4320' },
  { id: 'matrix', label: 'Matrix', bg: '#071108', fg: '#b8ffc6', border: '#1d5a2b' },
  { id: 'slate', label: 'Slate', bg: '#0b1119', fg: '#d8deea', border: '#27384d' },
  { id: 'paper', label: 'Paper', bg: '#f8f7f2', fg: '#1f2937', border: '#b8c2d1' },
]

const defaultUartSettings: UartSettings = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  bufferSize: 4096,
}

const tabSessionId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

const parseNumber = (value: unknown, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
const parseDataBits = (value: unknown): DataBits => (Number(value) === 7 ? 7 : 8)
const parseStopBits = (value: unknown): StopBits => (Number(value) === 2 ? 2 : 1)
const parseParity = (value: unknown): Parity =>
  value === 'even' || value === 'odd' ? value : 'none'
const parseFlowControl = (value: unknown): FlowControl =>
  value === 'hardware' ? 'hardware' : 'none'
const sanitizeRxText = (text: string) => text.replaceAll(ansiEscapeRegex, '')

const getTerminalTheme = (themeId: string): TerminalTheme => {
  const theme = terminalThemes.find((item) => item.id === themeId)
  return theme ?? terminalThemes[0]
}

const normalizeUartName = (raw: string) => {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return normalized || defaultWorkspaceName
}

const getWorkspacePath = (workspaceName: string) =>
  `${appRoutePrefix}/${normalizeUartName(workspaceName)}`

const getWorkspaceNameFromPath = (pathname: string) => {
  const normalizedPath = decodeURIComponent(pathname)
  const pathWithoutPrefix = normalizedPath.startsWith(`${appRoutePrefix}/`)
    ? normalizedPath.slice(appRoutePrefix.length + 1)
    : ''
  const pathSegment = pathWithoutPrefix.split('/').filter(Boolean)[0] ?? ''
  return {
    hadPathSegment: pathSegment.length > 0,
    workspaceName: normalizeUartName(pathSegment),
  }
}

const navigateToWorkspace = (workspaceName: string, replace = true) => {
  const nextPath = getWorkspacePath(workspaceName)
  if (replace) {
    window.history.replaceState({}, '', nextPath)
    return
  }
  window.history.pushState({}, '', nextPath)
}

const getConnectionLockKey = (uartName: string) =>
  `${connectionLockPrefix}${normalizeUartName(uartName)}`

const readConnectionLock = (uartName: string): ConnectionLock | null => {
  const raw = window.localStorage.getItem(getConnectionLockKey(uartName))
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ConnectionLock>
    if (typeof parsed.owner !== 'string' || typeof parsed.timestamp !== 'number') {
      return null
    }
    return { owner: parsed.owner, timestamp: parsed.timestamp }
  } catch {
    return null
  }
}

const isLockActive = (lock: ConnectionLock) => Date.now() - lock.timestamp < lockTtlMs

const isUartNameTakenByOther = (uartName: string) => {
  const lock = readConnectionLock(uartName)
  if (!lock) {
    return false
  }
  return isLockActive(lock) && lock.owner !== tabSessionId
}

const writeConnectionLock = (uartName: string) => {
  const lock: ConnectionLock = { owner: tabSessionId, timestamp: Date.now() }
  window.localStorage.setItem(getConnectionLockKey(uartName), JSON.stringify(lock))
}

const releaseConnectionLock = (uartName: string | null) => {
  if (!uartName) {
    return
  }
  const lock = readConnectionLock(uartName)
  if (lock?.owner === tabSessionId) {
    window.localStorage.removeItem(getConnectionLockKey(uartName))
  }
}

const claimConnectionLock = (uartName: string) => {
  if (isUartNameTakenByOther(uartName)) {
    return false
  }
  writeConnectionLock(uartName)
  return true
}

const splitRootEl = document.querySelector<HTMLElement>('#splitRoot')
const paneMenuEl = document.querySelector<HTMLDivElement>('#paneMenu')
const firstOpenTipEl = document.querySelector<HTMLElement>('#firstOpenTip')
const dismissTipBtn = document.querySelector<HTMLButtonElement>('#dismissTipBtn')

const settingsPanelEl = document.querySelector<HTMLElement>('#settingsPanel')
const closeSettingsBtn = document.querySelector<HTMLButtonElement>('#closeSettingsBtn')
const saveSettingsBtn = document.querySelector<HTMLButtonElement>('#saveSettingsBtn')
const baudRateEl = document.querySelector<HTMLInputElement>('#baudRate')
const dataBitsEl = document.querySelector<HTMLSelectElement>('#dataBits')
const stopBitsEl = document.querySelector<HTMLSelectElement>('#stopBits')
const parityEl = document.querySelector<HTMLSelectElement>('#parity')
const flowControlEl = document.querySelector<HTMLSelectElement>('#flowControl')
const bufferSizeEl = document.querySelector<HTMLInputElement>('#bufferSize')

if (
  !splitRootEl ||
  !paneMenuEl ||
  !firstOpenTipEl ||
  !dismissTipBtn ||
  !settingsPanelEl ||
  !closeSettingsBtn ||
  !saveSettingsBtn ||
  !baudRateEl ||
  !dataBitsEl ||
  !stopBitsEl ||
  !parityEl ||
  !flowControlEl ||
  !bufferSizeEl
) {
  throw new Error('Failed to locate required UI elements')
}

let paneIdCounter = 0
let splitIdCounter = 0
const panes = new Map<string, PaneState>()
const splitRatios = new Map<string, number>()
let activePaneId = ''
let rootNode: PaneTreeNode
let menuPaneId: string | null = null
let optionsOpenPaneId: string | null = null
let settingsPaneId: string | null = null
let lockHeartbeatTimer: number | null = null
let splitResizeState: { splitId: string; pointerId: number } | null = null

const nextPaneId = () => {
  paneIdCounter += 1
  return `pane-${paneIdCounter}`
}

const nextSplitId = () => {
  splitIdCounter += 1
  return `split-${splitIdCounter}`
}

const createPane = (uartName?: string): PaneState => ({
  id: nextPaneId(),
  uartName: normalizeUartName(uartName ?? `uart-${paneIdCounter + 1}`),
  settings: { ...defaultUartSettings },
  serialPort: null,
  reader: null,
  isReading: false,
  isConnected: false,
  connectedBaudRate: null,
  connectedUartName: null,
  statusMessage: '',
  rxLog: '',
  txInput: '',
  lineEnding: '\n',
  txExpanded: false,
  autoScroll: true,
  terminalFontRem: defaultTerminalFontRem,
  terminalThemeId: defaultTerminalThemeId,
})

const countPanes = (node: PaneTreeNode): number => {
  if (node.kind === 'pane') {
    return 1
  }
  return countPanes(node.first) + countPanes(node.second)
}

const collectPaneIds = (node: PaneTreeNode): string[] => {
  if (node.kind === 'pane') {
    return [node.paneId]
  }
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)]
}

const replacePaneWithSplit = (
  node: PaneTreeNode,
  paneId: string,
  orientation: SplitOrientation,
  newPaneId: string,
): PaneTreeNode => {
  if (node.kind === 'pane') {
    if (node.paneId !== paneId) {
      return node
    }
    return {
      kind: 'split',
      splitId: nextSplitId(),
      orientation,
      first: node,
      second: { kind: 'pane', paneId: newPaneId },
    }
  }
  return {
    kind: 'split',
    splitId: node.splitId,
    orientation: node.orientation,
    first: replacePaneWithSplit(node.first, paneId, orientation, newPaneId),
    second: replacePaneWithSplit(node.second, paneId, orientation, newPaneId),
  }
}

const removePaneFromTree = (
  node: PaneTreeNode,
  paneId: string,
): PaneTreeNode | null => {
  if (node.kind === 'pane') {
    return node.paneId === paneId ? null : node
  }
  const first = removePaneFromTree(node.first, paneId)
  const second = removePaneFromTree(node.second, paneId)

  if (!first && !second) {
    return null
  }
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return {
    kind: 'split',
    splitId: node.splitId,
    orientation: node.orientation,
    first,
    second,
  }
}

const pickNextPaneUartName = () => {
  const usedNames = new Set(Array.from(panes.values(), (pane) => pane.uartName))
  for (let i = 1; i <= 999; i += 1) {
    const candidate = normalizeUartName(`uart-${i}`)
    if (!usedNames.has(candidate) && !isUartNameTakenByOther(candidate)) {
      return candidate
    }
  }
  return normalizeUartName(`uart-${Date.now()}`)
}

const appendPaneLog = (paneId: string, text: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  pane.rxLog += text
  if (pane.rxLog.length > maxLogChars) {
    pane.rxLog = pane.rxLog.slice(-maxLogChars)
  }
  const terminalEl = splitRootEl.querySelector<HTMLElement>(`.terminal[data-pane-id="${paneId}"]`)
  if (!terminalEl) {
    return
  }
  terminalEl.textContent = pane.rxLog
  if (pane.autoScroll) {
    terminalEl.scrollTop = terminalEl.scrollHeight
  }
}

const setPaneStatus = (paneId: string, message: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  pane.statusMessage = message
  render()
}

const isPortAlreadyUsed = (port: SerialPort, currentPaneId: string) => {
  for (const pane of panes.values()) {
    if (pane.id !== currentPaneId && pane.isConnected && pane.serialPort === port) {
      return true
    }
  }
  return false
}

const updateHeartbeat = () => {
  const connectedNames = Array.from(panes.values())
    .filter((pane) => pane.isConnected && pane.connectedUartName)
    .map((pane) => pane.connectedUartName as string)

  if (connectedNames.length === 0) {
    if (lockHeartbeatTimer !== null) {
      window.clearInterval(lockHeartbeatTimer)
      lockHeartbeatTimer = null
    }
    return
  }

  if (lockHeartbeatTimer === null) {
    lockHeartbeatTimer = window.setInterval(() => {
      for (const pane of panes.values()) {
        if (pane.isConnected && pane.connectedUartName) {
          writeConnectionLock(pane.connectedUartName)
        }
      }
    }, lockHeartbeatMs)
  }
}

const disconnectPane = async (paneId: string, appendNote = true) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }

  pane.isReading = false
  try {
    await pane.reader?.cancel()
  } catch {
    // Ignore cancel errors while disconnecting.
  }
  try {
    await pane.serialPort?.close()
  } catch {
    // Ignore close errors while disconnecting.
  }

  releaseConnectionLock(pane.connectedUartName)

  pane.serialPort = null
  pane.reader = null
  pane.isConnected = false
  pane.connectedBaudRate = null
  pane.connectedUartName = null
  pane.statusMessage = ''
  if (appendNote) {
    appendPaneLog(paneId, '\n[Disconnected]\n')
  }

  updateHeartbeat()
  render()
}

const readLoop = async (paneId: string) => {
  const pane = panes.get(paneId)
  if (!pane?.serialPort?.readable) {
    return
  }

  pane.isReading = true
  try {
    while (true) {
      const current = panes.get(paneId)
      if (!current || !current.serialPort?.readable || !current.isReading) {
        break
      }

      const reader = current.serialPort.readable.getReader()
      current.reader = reader

      try {
        while (current.isReading) {
          const { value, done } = await reader.read()
          if (done) {
            break
          }
          if (value) {
            appendPaneLog(paneId, sanitizeRxText(textDecoder.decode(value, { stream: true })))
          }
        }
      } finally {
        reader.releaseLock()
        const latest = panes.get(paneId)
        if (latest) {
          latest.reader = null
        }
      }
    }
  } catch (error) {
    appendPaneLog(paneId, `\n[Read error] ${(error as Error).message}\n`)
    setPaneStatus(paneId, 'read error')
  }
}

const connectPane = async (paneId: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }

  if (!navigator.serial) {
    pane.statusMessage = 'Web Serial unavailable in this browser'
    render()
    return
  }

  if (pane.isConnected) {
    return
  }

  pane.uartName = normalizeUartName(pane.uartName)
  if (!claimConnectionLock(pane.uartName)) {
    pane.statusMessage = `uart name ${pane.uartName} is in use`
    render()
    window.alert(`UART name "${pane.uartName}" is in use. Pick another pane UART name.`)
    return
  }

  try {
    pane.statusMessage = 'waiting for port selection'
    render()
    const selectedPort = await navigator.serial.requestPort()

    if (isPortAlreadyUsed(selectedPort, paneId)) {
      releaseConnectionLock(pane.uartName)
      pane.statusMessage = 'this serial port is already connected in another pane'
      render()
      window.alert('This serial port is already connected in another pane.')
      return
    }

    await selectedPort.open({
      baudRate: pane.settings.baudRate,
      dataBits: pane.settings.dataBits,
      stopBits: pane.settings.stopBits,
      parity: pane.settings.parity,
      flowControl: pane.settings.flowControl,
      bufferSize: pane.settings.bufferSize,
    })

    pane.serialPort = selectedPort
    pane.isConnected = true
    pane.connectedBaudRate = pane.settings.baudRate
    pane.connectedUartName = pane.uartName
    pane.statusMessage = ''
    appendPaneLog(paneId, '\n[Connected]\n')

    updateHeartbeat()
    render()
    void readLoop(paneId)
  } catch (error) {
    releaseConnectionLock(pane.uartName)
    pane.serialPort = null
    pane.isConnected = false
    pane.connectedBaudRate = null
    pane.connectedUartName = null
    pane.statusMessage = `connect failed: ${(error as Error).message}`
    render()
  }
}

const sendPaneText = async (paneId: string) => {
  const pane = panes.get(paneId)
  if (!pane?.serialPort?.writable) {
    return
  }

  const writer = pane.serialPort.writable.getWriter()
  try {
    await writer.write(textEncoder.encode(pane.txInput + pane.lineEnding))
  } catch (error) {
    pane.statusMessage = `send failed: ${(error as Error).message}`
    render()
  } finally {
    writer.releaseLock()
  }
}

const getTimestampSuffix = () => {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

const downloadBlob = (blob: Blob, filename: string) => {
  const link = document.createElement('a')
  const objectUrl = URL.createObjectURL(blob)
  link.href = objectUrl
  link.download = filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}

const copyPaneLog = async (paneId: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(pane.rxLog)
    } else {
      const fallbackTextArea = document.createElement('textarea')
      fallbackTextArea.value = pane.rxLog
      fallbackTextArea.style.position = 'fixed'
      fallbackTextArea.style.opacity = '0'
      document.body.appendChild(fallbackTextArea)
      fallbackTextArea.focus()
      fallbackTextArea.select()
      document.execCommand('copy')
      fallbackTextArea.remove()
    }
    pane.statusMessage = 'log copied to clipboard'
    render()
  } catch (error) {
    pane.statusMessage = `copy failed: ${(error as Error).message}`
    render()
  }
}

const wrapLogTextForPdf = (logText: string, maxLineLength = 100) => {
  const lines: string[] = []
  const normalizedLines = logText.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')

  for (const rawLine of normalizedLines) {
    const line = rawLine.length === 0 ? ' ' : rawLine
    for (let index = 0; index < line.length; index += maxLineLength) {
      lines.push(line.slice(index, index + maxLineLength))
    }
    if (rawLine.length === 0) {
      continue
    }
  }
  return lines
}

const escapePdfText = (value: string) =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
    .replace(/[^\t\x20-\x7e]/g, '?')

const buildSimplePdf = (title: string, bodyLines: string[]) => {
  const pageWidth = 612
  const pageHeight = 792
  const margin = 36
  const fontSize = 9
  const lineHeight = 11
  const linesPerPage = Math.floor((pageHeight - margin * 2) / lineHeight)
  const pages: string[][] = []

  for (let index = 0; index < bodyLines.length; index += linesPerPage) {
    pages.push(bodyLines.slice(index, index + linesPerPage))
  }
  if (pages.length === 0) {
    pages.push([' '])
  }

  const objects: string[] = []
  const addObject = (content: string) => {
    objects.push(content)
    return objects.length
  }

  const catalogIndex = addObject('')
  const pagesIndex = addObject('')
  const fontIndex = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>')

  const pageObjectIndices: number[] = []
  const contentObjectIndices: number[] = []

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const pageLines = pages[pageIndex]
    const contentParts: string[] = [
      'BT',
      `/F1 ${fontSize} Tf`,
      `${lineHeight} TL`,
      `1 0 0 1 ${margin} ${pageHeight - margin - fontSize} Tm`,
      `(${escapePdfText(title)}) Tj`,
      'T*',
      `(${escapePdfText('-'.repeat(90))}) Tj`,
      'T*',
    ]

    for (const line of pageLines) {
      contentParts.push(`(${escapePdfText(line)}) Tj`)
      contentParts.push('T*')
    }
    contentParts.push('ET')

    const contentStream = contentParts.join('\n')
    const contentIndex = addObject(
      `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
    )
    contentObjectIndices.push(contentIndex)

    const pageIndexObject = addObject('')
    pageObjectIndices.push(pageIndexObject)
  }

  objects[catalogIndex - 1] = `<< /Type /Catalog /Pages ${pagesIndex} 0 R >>`
  objects[pagesIndex - 1] = `<< /Type /Pages /Kids [${pageObjectIndices.map((index) => `${index} 0 R`).join(' ')}] /Count ${pageObjectIndices.length} >>`

  for (let pageIndex = 0; pageIndex < pageObjectIndices.length; pageIndex += 1) {
    const pageObjectIndex = pageObjectIndices[pageIndex]
    const contentIndex = contentObjectIndices[pageIndex]
    objects[pageObjectIndex - 1] = `<< /Type /Page /Parent ${pagesIndex} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontIndex} 0 R >> >> /Contents ${contentIndex} 0 R >>`
  }

  const header = '%PDF-1.4\n'
  const body: string[] = []
  const offsets: number[] = [0]
  let byteLength = header.length

  for (let objectNumber = 0; objectNumber < objects.length; objectNumber += 1) {
    const serialized = `${objectNumber + 1} 0 obj\n${objects[objectNumber]}\nendobj\n`
    offsets.push(byteLength)
    body.push(serialized)
    byteLength += serialized.length
  }

  const xrefStart = byteLength
  const xrefEntries = offsets
    .map((offset, index) =>
      index === 0 ? '0000000000 65535 f ' : `${String(offset).padStart(10, '0')} 00000 n `,
    )
    .join('\n')

  const pdf = [
    header,
    ...body,
    `xref\n0 ${objects.length + 1}\n${xrefEntries}\n`,
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogIndex} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`,
  ].join('')

  return new Blob([pdf], { type: 'application/pdf' })
}

const exportPaneLogTxt = (paneId: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  const filename = `${normalizeUartName(pane.uartName)}-${getTimestampSuffix()}.txt`
  downloadBlob(new Blob([pane.rxLog], { type: 'text/plain;charset=utf-8' }), filename)
  pane.statusMessage = `exported ${filename}`
  render()
}

const exportPaneLogPdf = (paneId: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  const filename = `${normalizeUartName(pane.uartName)}-${getTimestampSuffix()}.pdf`
  const bodyLines = wrapLogTextForPdf(pane.rxLog, 100)
  const pdfBlob = buildSimplePdf(`UART Log - ${pane.uartName}`, bodyLines)
  downloadBlob(pdfBlob, filename)
  pane.statusMessage = `exported ${filename}`
  render()
}

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const renderNode = (node: PaneTreeNode): string => {
  if (node.kind === 'pane') {
    const pane = panes.get(node.paneId)
    if (!pane) {
      return ''
    }

    const isActive = activePaneId === pane.id
    const isMenuOpen = optionsOpenPaneId === pane.id
    const terminalTheme = getTerminalTheme(pane.terminalThemeId)
    const themeOptionsHtml = terminalThemes
      .map(
        (theme) =>
          `<option value="${theme.id}" ${theme.id === pane.terminalThemeId ? 'selected' : ''}>${escapeHtml(theme.label)}</option>`,
      )
      .join('')
    const connectAction = pane.isConnected ? 'disconnect' : 'connect'
    const connectLabel = pane.isConnected ? 'Disconnect' : 'Connect'
    const statusText = pane.isConnected
      ? `connected - ${pane.connectedBaudRate ?? pane.settings.baudRate}`
      : 'disconnected'

    return `
      <section class="pane ${isActive ? 'active' : ''}" data-pane-id="${pane.id}" tabindex="0">
        <header class="paneHeader">
          <div class="paneToolbar">
            <input class="paneNameInput" data-pane-id="${pane.id}" value="${escapeHtml(pane.uartName)}" maxlength="40" placeholder="uart-name" title="Click to rename" />
            <button class="ghost mini" data-action="settings" data-pane-id="${pane.id}" type="button" title="UART settings"><span class="btnIcon">⚙</span><span class="btnLabel"> Settings</span></button>
            <div class="optionsControl" data-pane-id="${pane.id}">
              <button class="ghost mini" data-action="toggle-options" data-pane-id="${pane.id}" type="button" title="Options">⋯</button>
              <div class="optionsMenu ${isMenuOpen ? '' : 'hidden'}" aria-hidden="${String(!isMenuOpen)}">
                <button class="menuItem" data-action="toggle-tx" data-pane-id="${pane.id}" type="button">${pane.txExpanded ? 'Hide TX' : 'Show TX'}</button>
                <button class="menuItem" data-action="copy-log" data-pane-id="${pane.id}" type="button">Copy Log</button>
                <button class="menuItem" data-action="export-txt" data-pane-id="${pane.id}" type="button">Export TXT</button>
                <button class="menuItem" data-action="export-pdf" data-pane-id="${pane.id}" type="button">Export PDF</button>
                <button class="menuItem" data-action="clear-log" data-pane-id="${pane.id}" type="button">Clear</button>
                <button class="menuItem checkItem" data-action="toggle-auto-scroll" data-pane-id="${pane.id}" type="button"><span class="checkMark">${pane.autoScroll ? '☑' : '☐'}</span> Auto-scroll (Alt+S)</button>
                <button class="menuItem" data-action="font-smaller" data-pane-id="${pane.id}" type="button">Font -</button>
                <button class="menuItem" data-action="font-larger" data-pane-id="${pane.id}" type="button">Font +</button>
                <button class="menuItem" data-action="font-reset" data-pane-id="${pane.id}" type="button">Font reset</button>
                <div class="menuGroup" role="group" aria-label="Theme options">
                  <label class="themePicker">
                    <span class="themeLabel">Theme</span>
                    <select class="themeSelect" data-pane-id="${pane.id}">
                      ${themeOptionsHtml}
                    </select>
                  </label>
                </div>
              </div>
            </div>
            <button class="ghost mini ${pane.isConnected ? 'isConnected' : ''}" data-action="${connectAction}" data-pane-id="${pane.id}" type="button"><span class="btnIcon">⏻</span><span class="btnLabel"> ${connectLabel}</span></button>
          </div>
          <p class="paneStatus">${escapeHtml(pane.uartName)} | ${statusText}${pane.statusMessage ? ` | ${escapeHtml(pane.statusMessage)}` : ''}</p>
        </header>
        <pre class="terminal" data-pane-id="${pane.id}" aria-live="polite" style="font-size: ${pane.terminalFontRem.toFixed(2)}rem; background: ${terminalTheme.bg}; color: ${terminalTheme.fg}; border-color: ${terminalTheme.border};">${escapeHtml(pane.rxLog)}</pre>
        <section class="txPanel ${pane.txExpanded ? '' : 'collapsed'}" aria-hidden="${String(!pane.txExpanded)}">
          <textarea class="txInput" data-pane-id="${pane.id}" rows="3" placeholder="Type bytes as text...">${escapeHtml(pane.txInput)}</textarea>
          <div class="txRow">
            <label>
              Line ending
              <select class="lineEnding" data-pane-id="${pane.id}">
                <option value="" ${pane.lineEnding === '' ? 'selected' : ''}>none</option>
                <option value="\n" ${pane.lineEnding === '\n' ? 'selected' : ''}>LF (\\n)</option>
                <option value="\r\n" ${pane.lineEnding === '\r\n' ? 'selected' : ''}>CRLF (\\r\\n)</option>
                <option value="\r" ${pane.lineEnding === '\r' ? 'selected' : ''}>CR (\\r)</option>
              </select>
            </label>
            <button class="primary" data-action="send" data-pane-id="${pane.id}" type="button" ${pane.isConnected ? '' : 'disabled'}>Send</button>
          </div>
        </section>
      </section>
    `
  }

  const ratio = splitRatios.get(node.splitId) ?? 0.5
  const firstPercent = Math.round(ratio * 1000) / 10
  const secondPercent = Math.round((1 - ratio) * 1000) / 10

  return `
    <section class="split ${node.orientation}" data-split-id="${node.splitId}">
      <div class="splitPane splitPaneFirst" style="flex: 0 0 ${firstPercent}%">
        ${renderNode(node.first)}
      </div>
      <div class="splitDivider ${node.orientation}" data-split-id="${node.splitId}" role="separator" aria-orientation="${node.orientation === 'vertical' ? 'vertical' : 'horizontal'}"></div>
      <div class="splitPane splitPaneSecond" style="flex: 0 0 ${secondPercent}%">
        ${renderNode(node.second)}
      </div>
    </section>
  `
}

const render = () => {
  splitRootEl.innerHTML = renderNode(rootNode)

  for (const pane of panes.values()) {
    const terminalEl = splitRootEl.querySelector<HTMLElement>(`.terminal[data-pane-id="${pane.id}"]`)
    if (terminalEl && pane.autoScroll) {
      terminalEl.scrollTop = terminalEl.scrollHeight
    }
  }
}

const setPaneAsActive = (paneId: string) => {
  if (!panes.has(paneId)) {
    return
  }
  if (activePaneId === paneId) {
    return
  }
  activePaneId = paneId
  render()
}

const openSettingsForPane = (paneId: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  settingsPaneId = paneId
  baudRateEl.value = String(pane.settings.baudRate)
  dataBitsEl.value = String(pane.settings.dataBits)
  stopBitsEl.value = String(pane.settings.stopBits)
  parityEl.value = pane.settings.parity
  flowControlEl.value = pane.settings.flowControl
  bufferSizeEl.value = String(pane.settings.bufferSize)
  settingsPanelEl.classList.remove('hidden')
  settingsPanelEl.setAttribute('aria-hidden', 'false')
}

const closeSettings = () => {
  settingsPaneId = null
  settingsPanelEl.classList.add('hidden')
  settingsPanelEl.setAttribute('aria-hidden', 'true')
}

const splitActivePane = (orientation: SplitOrientation) => {
  if (countPanes(rootNode) >= maxPaneCount) {
    setPaneStatus(activePaneId, `max ${maxPaneCount} panes reached`)
    return
  }
  const newPane = createPane(pickNextPaneUartName())
  panes.set(newPane.id, newPane)
  rootNode = replacePaneWithSplit(rootNode, activePaneId, orientation, newPane.id)
  if (rootNode.kind === 'split') {
    splitRatios.set(rootNode.splitId, 0.5)
  }
  activePaneId = newPane.id
  render()
}

const closeActivePane = async () => {
  if (countPanes(rootNode) <= 1) {
    setPaneStatus(activePaneId, 'at least one pane is required')
    return
  }
  const toClose = activePaneId
  await disconnectPane(toClose, false)
  panes.delete(toClose)
  const nextTree = removePaneFromTree(rootNode, toClose)
  if (!nextTree) {
    return
  }
  rootNode = nextTree
  const paneIds = collectPaneIds(rootNode)
  activePaneId = paneIds[0]
  render()
}

const showPaneMenu = (x: number, y: number, paneId: string) => {
  menuPaneId = paneId
  paneMenuEl.style.left = `${x}px`
  paneMenuEl.style.top = `${y}px`
  paneMenuEl.classList.remove('hidden')
  paneMenuEl.setAttribute('aria-hidden', 'false')
}

const hidePaneMenu = () => {
  menuPaneId = null
  paneMenuEl.classList.add('hidden')
  paneMenuEl.setAttribute('aria-hidden', 'true')
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const updateSplitRatioFromPointer = (splitId: string, clientX: number, clientY: number) => {
  const splitEl = splitRootEl.querySelector<HTMLElement>(`.split[data-split-id="${splitId}"]`)
  if (!splitEl) {
    return
  }

  const rect = splitEl.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return
  }

  const direction = window.getComputedStyle(splitEl).flexDirection
  const isRow = direction.startsWith('row')
  const rawRatio = isRow
    ? (clientX - rect.left) / rect.width
    : (clientY - rect.top) / rect.height
  const ratio = clamp(rawRatio, 0.18, 0.82)

  splitRatios.set(splitId, ratio)
  render()
}

const handlePaneAction = async (action: string, paneId: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }

  switch (action) {
    case 'connect':
      await connectPane(paneId)
      return
    case 'disconnect':
      await disconnectPane(paneId)
      return
    case 'settings':
      openSettingsForPane(paneId)
      return
    case 'toggle-options':
      optionsOpenPaneId = optionsOpenPaneId === paneId ? null : paneId
      render()
      return
    case 'toggle-auto-scroll':
      pane.autoScroll = !pane.autoScroll
      pane.statusMessage = pane.autoScroll ? 'auto-scroll enabled' : 'auto-scroll paused'
      render()
      return
    case 'font-smaller': {
      const nextFont = clamp(
        pane.terminalFontRem - terminalFontStepRem,
        minTerminalFontRem,
        maxTerminalFontRem,
      )
      pane.terminalFontRem = Number(nextFont.toFixed(2))
      pane.statusMessage = `font ${pane.terminalFontRem.toFixed(2)}rem`
      render()
      return
    }
    case 'font-larger': {
      const nextFont = clamp(
        pane.terminalFontRem + terminalFontStepRem,
        minTerminalFontRem,
        maxTerminalFontRem,
      )
      pane.terminalFontRem = Number(nextFont.toFixed(2))
      pane.statusMessage = `font ${pane.terminalFontRem.toFixed(2)}rem`
      render()
      return
    }
    case 'font-reset':
      pane.terminalFontRem = defaultTerminalFontRem
      pane.statusMessage = `font ${pane.terminalFontRem.toFixed(2)}rem`
      render()
      return
    case 'toggle-tx':
      pane.txExpanded = !pane.txExpanded
      optionsOpenPaneId = null
      render()
      return
    case 'copy-log':
      optionsOpenPaneId = null
      await copyPaneLog(paneId)
      return
    case 'export-txt':
      optionsOpenPaneId = null
      exportPaneLogTxt(paneId)
      return
    case 'export-pdf':
      optionsOpenPaneId = null
      exportPaneLogPdf(paneId)
      return
    case 'clear-log':
      pane.rxLog = ''
      optionsOpenPaneId = null
      render()
      return
    case 'send':
      await sendPaneText(paneId)
      return
    case 'apply-pane-name': {
      const inputEl = splitRootEl.querySelector<HTMLInputElement>(
        `.paneNameInput[data-pane-id="${paneId}"]`,
      )
      if (!inputEl) {
        return
      }
      if (pane.isConnected) {
        pane.statusMessage = 'disconnect first before changing uart name'
        render()
        return
      }
      const nextName = normalizeUartName(inputEl.value)
      if (isUartNameTakenByOther(nextName)) {
        pane.statusMessage = `uart name ${nextName} is in use`
        render()
        window.alert(`UART name "${nextName}" is in use.`)
        return
      }
      pane.uartName = nextName
      pane.statusMessage = 'uart name updated'
      render()
      return
    }
    default:
  }
}

splitRootEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const paneEl = target.closest<HTMLElement>('.pane[data-pane-id]')
  const paneId = paneEl?.dataset.paneId
  if (paneId) {
    const isNameInputClick = target.matches('.paneNameInput[data-pane-id]')
    let needsRender = false

    if (!target.closest('.optionsControl') && optionsOpenPaneId !== null) {
      optionsOpenPaneId = null
      needsRender = true
    }

    if (activePaneId !== paneId) {
      activePaneId = paneId
      needsRender = true
    }

    if (isNameInputClick) {
      if (needsRender) {
        render()
        window.setTimeout(() => {
          const refreshedInput = splitRootEl.querySelector<HTMLInputElement>(
            `.paneNameInput[data-pane-id="${paneId}"]`,
          )
          if (!refreshedInput) {
            return
          }
          refreshedInput.focus()
          const caretPos = refreshedInput.value.length
          refreshedInput.setSelectionRange(caretPos, caretPos)
        }, 0)
      }
      return
    }

    if (needsRender) {
      render()
    }
  }
})

splitRootEl.addEventListener('contextmenu', (event) => {
  const target = event.target as HTMLElement
  const paneEl = target.closest<HTMLElement>('.pane[data-pane-id]')
  if (!paneEl?.dataset.paneId) {
    return
  }
  event.preventDefault()
  setPaneAsActive(paneEl.dataset.paneId)
  showPaneMenu(event.clientX, event.clientY, paneEl.dataset.paneId)
})

splitRootEl.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement
  const divider = target.closest<HTMLElement>('.splitDivider[data-split-id]')
  if (!divider || typeof event.pointerId !== 'number') {
    return
  }

  event.preventDefault()
  const splitId = divider.dataset.splitId
  if (!splitId) {
    return
  }

  splitResizeState = {
    splitId,
    pointerId: event.pointerId,
  }

  updateSplitRatioFromPointer(splitId, event.clientX, event.clientY)
})

window.addEventListener('pointermove', (event) => {
  if (!splitResizeState || event.pointerId !== splitResizeState.pointerId) {
    return
  }

  updateSplitRatioFromPointer(splitResizeState.splitId, event.clientX, event.clientY)
})

window.addEventListener('pointerup', (event) => {
  if (!splitResizeState || event.pointerId !== splitResizeState.pointerId) {
    return
  }

  splitResizeState = null
})

splitRootEl.addEventListener('input', (event) => {
  const target = event.target as HTMLElement

  if (target.matches('.txInput[data-pane-id]')) {
    const paneId = target.getAttribute('data-pane-id')
    const pane = paneId ? panes.get(paneId) : null
    if (pane && target instanceof HTMLTextAreaElement) {
      pane.txInput = target.value
    }
  }
})

splitRootEl.addEventListener('focusout', (event) => {
  const target = event.target as HTMLElement
  if (!target.matches('.paneNameInput[data-pane-id]')) {
    return
  }
  const paneId = target.getAttribute('data-pane-id')
  if (!paneId) {
    return
  }
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  if (pane.isConnected) {
    pane.statusMessage = 'disconnect first before changing uart name'
    window.setTimeout(() => render(), 0)
    return
  }
  const nextName = normalizeUartName((target as HTMLInputElement).value)
  if (nextName === pane.uartName) {
    return
  }
  if (isUartNameTakenByOther(nextName)) {
    pane.statusMessage = `uart name ${nextName} is in use`
    window.setTimeout(() => render(), 0)
    return
  }
  pane.uartName = nextName
  pane.statusMessage = 'uart name updated'
  window.setTimeout(() => render(), 0)
})

splitRootEl.addEventListener('change', (event) => {
  const target = event.target as HTMLElement
  if (target.matches('.lineEnding[data-pane-id]') && target instanceof HTMLSelectElement) {
    const paneId = target.getAttribute('data-pane-id')
    const pane = paneId ? panes.get(paneId) : null
    if (pane) {
      const value = target.value as PaneState['lineEnding']
      pane.lineEnding = value
    }
    return
  }

  if (target.matches('.themeSelect[data-pane-id]') && target instanceof HTMLSelectElement) {
    const paneId = target.getAttribute('data-pane-id')
    const pane = paneId ? panes.get(paneId) : null
    if (!pane) {
      return
    }
    const selectedTheme = getTerminalTheme(target.value)
    pane.terminalThemeId = selectedTheme.id
    pane.statusMessage = `theme ${selectedTheme.label}`
    render()
  }
})

splitRootEl.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement

  if (event.key === 'Enter' && target.matches('.paneNameInput[data-pane-id]')) {
    event.preventDefault()
    ;(target as HTMLInputElement).blur()
    return
  }

  if (
    event.key === 'Enter' &&
    (event.ctrlKey || event.metaKey) &&
    target.matches('.txInput[data-pane-id]')
  ) {
    event.preventDefault()
    const paneId = target.getAttribute('data-pane-id')
    if (paneId) {
      void sendPaneText(paneId)
    }
  }
})

splitRootEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const actionButton = target.closest<HTMLButtonElement>('button[data-action][data-pane-id]')
  if (!actionButton) {
    return
  }
  const action = actionButton.getAttribute('data-action')
  const paneId = actionButton.getAttribute('data-pane-id')
  if (!action || !paneId) {
    return
  }
  void handlePaneAction(action, paneId)
})

paneMenuEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const button = target.closest<HTMLButtonElement>('button[data-menu-action]')
  if (!button || !menuPaneId) {
    return
  }

  const action = button.getAttribute('data-menu-action')
  hidePaneMenu()
  if (action === 'split-vertical') {
    splitActivePane('vertical')
  } else if (action === 'split-horizontal') {
    splitActivePane('horizontal')
  } else if (action === 'close-pane') {
    void closeActivePane()
  }
})

document.addEventListener('click', (event) => {
  if (!paneMenuEl.contains(event.target as Node)) {
    hidePaneMenu()
  }
  const clickPath = event.composedPath()
  const clickedInsideSplitRoot = clickPath.includes(splitRootEl)
  if (!clickedInsideSplitRoot && optionsOpenPaneId !== null) {
    optionsOpenPaneId = null
    render()
  }
})

window.addEventListener('keydown', (event) => {
  if (event.altKey && !event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 's') {
    const activePane = panes.get(activePaneId)
    if (activePane) {
      event.preventDefault()
      activePane.autoScroll = !activePane.autoScroll
      activePane.statusMessage = activePane.autoScroll
        ? 'auto-scroll enabled (Alt+S)'
        : 'auto-scroll paused (Alt+S)'
      render()
    }
    return
  }

  if (event.key === 'Escape') {
    hidePaneMenu()
    closeSettings()
  }
})

dismissTipBtn.addEventListener('click', () => {
  firstOpenTipEl.classList.add('hidden')
  firstOpenTipEl.setAttribute('aria-hidden', 'true')
  window.localStorage.setItem(tipStorageKey, '1')
})

closeSettingsBtn.addEventListener('click', () => {
  closeSettings()
})

saveSettingsBtn.addEventListener('click', () => {
  if (!settingsPaneId) {
    return
  }
  const pane = panes.get(settingsPaneId)
  if (!pane) {
    closeSettings()
    return
  }

  pane.settings = {
    baudRate: parseNumber(baudRateEl.value, defaultUartSettings.baudRate),
    dataBits: parseDataBits(dataBitsEl.value),
    stopBits: parseStopBits(stopBitsEl.value),
    parity: parseParity(parityEl.value),
    flowControl: parseFlowControl(flowControlEl.value),
    bufferSize: Math.max(255, parseNumber(bufferSizeEl.value, defaultUartSettings.bufferSize)),
  }

  pane.statusMessage = 'settings saved (applies on next connect)'
  closeSettings()
  render()
})

const initialize = () => {
  const { hadPathSegment, workspaceName } = getWorkspaceNameFromPath(window.location.pathname)
  if (!hadPathSegment || window.location.pathname !== getWorkspacePath(workspaceName)) {
    navigateToWorkspace(workspaceName)
  }

  const firstPane = createPane('uart-1')
  panes.set(firstPane.id, firstPane)
  activePaneId = firstPane.id
  rootNode = { kind: 'pane', paneId: firstPane.id }

  if (!window.localStorage.getItem(tipStorageKey)) {
    firstOpenTipEl.classList.remove('hidden')
    firstOpenTipEl.setAttribute('aria-hidden', 'false')
  }

  if (!navigator.serial) {
    firstPane.statusMessage = 'Web Serial unsupported. Use Chrome or Edge on desktop.'
  }

  render()
}

window.addEventListener('popstate', () => {
  const { hadPathSegment, workspaceName } = getWorkspaceNameFromPath(window.location.pathname)
  if (!hadPathSegment || window.location.pathname !== getWorkspacePath(workspaceName)) {
    navigateToWorkspace(workspaceName)
  }
})

window.addEventListener('beforeunload', () => {
  if (lockHeartbeatTimer !== null) {
    window.clearInterval(lockHeartbeatTimer)
  }
  for (const pane of panes.values()) {
    releaseConnectionLock(pane.connectedUartName)
  }
})

initialize()

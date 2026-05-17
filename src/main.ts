import './style.css'

type Parity = 'none' | 'even' | 'odd'
type FlowControl = 'none' | 'hardware'
type DataBits = 7 | 8
type StopBits = 1 | 2

type UartSettings = {
  baudRate: number
  dataBits: DataBits
  stopBits: StopBits
  parity: Parity
  flowControl: FlowControl
  bufferSize: number
}

declare global {
  interface Navigator {
    serial?: {
      requestPort: () => Promise<SerialPort>
      addEventListener?: (
        type: 'connect' | 'disconnect',
        listener: (event: Event) => void,
      ) => void
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
    getInfo?: () => { usbVendorId?: number; usbProductId?: number }
  }
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('Failed to initialize app root')
}

app.innerHTML = `
  <main class="layout">
    <section class="card controls">
      <div class="actions">
        <div class="nameControls" role="group" aria-label="UART name">
          <input id="uartNameInput" type="text" maxlength="40" placeholder="uart-a" />
          <button id="applyNameBtn" class="ghost" type="button">Use Name</button>
        </div>
        <button id="connectBtn" class="primary">Connect</button>
        <button id="disconnectBtn" class="ghost" disabled>Disconnect</button>
        <button id="newTabBtn" class="ghost" type="button">New Tab</button>
        <button id="openSettingsBtn" class="ghost">Settings</button>
        <button id="toggleTxBtn" class="ghost">Show TX</button>
        <button id="copyLogBtn" class="ghost" type="button">Copy Log</button>
        <div class="exportControl">
          <button id="exportBtn" class="ghost" type="button">Export</button>
          <div id="exportMenu" class="exportMenu hidden" aria-hidden="true">
            <button id="exportTxtBtn" class="menuItem" type="button">Export TXT</button>
            <button id="exportPdfBtn" class="menuItem" type="button">Export PDF</button>
          </div>
        </div>
        <button id="clearBtn" class="ghost">Clear RX</button>
        <label class="inlineToggle"><input id="autoScroll" type="checkbox" checked /> Auto-scroll</label>
      </div>
      <p id="status" class="status">Status: idle</p>
    </section>

    <section class="card rxCard">
      <pre id="rxLog" class="terminal" aria-live="polite"></pre>
    </section>

    <section id="txPanel" class="card txPanel collapsed" aria-hidden="true">
      <h2>TX send</h2>
      <textarea id="txInput" rows="4" placeholder="Type bytes as text..."></textarea>
      <div class="txRow">
        <label>
          Line ending
          <select id="lineEnding">
            <option value="">none</option>
            <option value="\n" selected>LF (\\n)</option>
            <option value="\r\n">CRLF (\\r\\n)</option>
            <option value="\r">CR (\\r)</option>
          </select>
        </label>
        <button id="sendBtn" class="primary" disabled>Send</button>
      </div>
    </section>

    <section id="settingsPanel" class="card settingsPanel hidden" aria-hidden="true">
      <div class="settingsHeader">
        <h2>UART settings</h2>
        <button id="closeSettingsBtn" class="ghost">Close</button>
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
      <p class="status">Settings apply on next connect.</p>
    </section>
  </main>
`

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const maxLogChars = 200_000
const ansiEscapeRegex = /\u001B\[[0-?]*[ -/]*[@-~]/g
const workspaceStoragePrefix = 'online-uart:workspace:'
const connectionLockPrefix = 'online-uart:connection-lock:'
const lockTtlMs = 8_000
const lockHeartbeatMs = 2_000
const appRoutePrefix = '/webuart'
const defaultWorkspaceName = 'uart-a'
const defaultUartSettings: UartSettings = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
  bufferSize: 4096,
}

let serialPort: SerialPort | null = null
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
let isReading = false
let uartWorkspaceName = defaultWorkspaceName
let isConnected = false
let connectedBaudRate: number | null = null
let connectedWorkspaceName: string | null = null
let lockHeartbeatTimer: number | null = null

const tabSessionId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`

type ConnectionLock = {
  owner: string
  timestamp: number
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

const baudRateEl = document.querySelector<HTMLInputElement>('#baudRate')
const dataBitsEl = document.querySelector<HTMLSelectElement>('#dataBits')
const stopBitsEl = document.querySelector<HTMLSelectElement>('#stopBits')
const parityEl = document.querySelector<HTMLSelectElement>('#parity')
const flowControlEl = document.querySelector<HTMLSelectElement>('#flowControl')
const bufferSizeEl = document.querySelector<HTMLInputElement>('#bufferSize')
const connectBtn = document.querySelector<HTMLButtonElement>('#connectBtn')
const disconnectBtn = document.querySelector<HTMLButtonElement>('#disconnectBtn')
const newTabBtn = document.querySelector<HTMLButtonElement>('#newTabBtn')
const uartNameInputEl = document.querySelector<HTMLInputElement>('#uartNameInput')
const applyNameBtn = document.querySelector<HTMLButtonElement>('#applyNameBtn')
const openSettingsBtn = document.querySelector<HTMLButtonElement>('#openSettingsBtn')
const closeSettingsBtn = document.querySelector<HTMLButtonElement>('#closeSettingsBtn')
const toggleTxBtn = document.querySelector<HTMLButtonElement>('#toggleTxBtn')
const copyLogBtn = document.querySelector<HTMLButtonElement>('#copyLogBtn')
const exportBtn = document.querySelector<HTMLButtonElement>('#exportBtn')
const exportMenuEl = document.querySelector<HTMLDivElement>('#exportMenu')
const exportTxtBtn = document.querySelector<HTMLButtonElement>('#exportTxtBtn')
const exportPdfBtn = document.querySelector<HTMLButtonElement>('#exportPdfBtn')
const txPanelEl = document.querySelector<HTMLElement>('#txPanel')
const settingsPanelEl = document.querySelector<HTMLElement>('#settingsPanel')
const clearBtn = document.querySelector<HTMLButtonElement>('#clearBtn')
const sendBtn = document.querySelector<HTMLButtonElement>('#sendBtn')
const statusEl = document.querySelector<HTMLParagraphElement>('#status')
const rxLogEl = document.querySelector<HTMLPreElement>('#rxLog')
const txInputEl = document.querySelector<HTMLTextAreaElement>('#txInput')
const lineEndingEl = document.querySelector<HTMLSelectElement>('#lineEnding')
const autoScrollEl = document.querySelector<HTMLInputElement>('#autoScroll')

if (
  !baudRateEl ||
  !dataBitsEl ||
  !stopBitsEl ||
  !parityEl ||
  !flowControlEl ||
  !bufferSizeEl ||
  !connectBtn ||
  !disconnectBtn ||
  !newTabBtn ||
  !uartNameInputEl ||
  !applyNameBtn ||
  !openSettingsBtn ||
  !closeSettingsBtn ||
  !toggleTxBtn ||
  !copyLogBtn ||
  !exportBtn ||
  !exportMenuEl ||
  !exportTxtBtn ||
  !exportPdfBtn ||
  !txPanelEl ||
  !settingsPanelEl ||
  !clearBtn ||
  !sendBtn ||
  !statusEl ||
  !rxLogEl ||
  !txInputEl ||
  !lineEndingEl ||
  !autoScrollEl
) {
  throw new Error('Failed to locate required UI elements')
}

uartNameInputEl.value = uartWorkspaceName

const getWorkspaceStorageKey = (workspaceName: string) =>
  `${workspaceStoragePrefix}${workspaceName}`

const getConnectionLockKey = (workspaceName: string) =>
  `${connectionLockPrefix}${workspaceName}`

const readConnectionLock = (workspaceName: string): ConnectionLock | null => {
  const raw = window.localStorage.getItem(getConnectionLockKey(workspaceName))
  if (!raw) {
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ConnectionLock>
    if (typeof parsed.owner !== 'string' || typeof parsed.timestamp !== 'number') {
      return null
    }

    return {
      owner: parsed.owner,
      timestamp: parsed.timestamp,
    }
  } catch {
    return null
  }
}

const isLockActive = (lock: ConnectionLock) => Date.now() - lock.timestamp < lockTtlMs

const isWorkspaceNameTakenByOther = (workspaceName: string) => {
  const lock = readConnectionLock(workspaceName)
  if (!lock) {
    return false
  }

  return isLockActive(lock) && lock.owner !== tabSessionId
}

const writeConnectionLock = (workspaceName: string) => {
  const lock: ConnectionLock = {
    owner: tabSessionId,
    timestamp: Date.now(),
  }
  window.localStorage.setItem(getConnectionLockKey(workspaceName), JSON.stringify(lock))
}

const releaseConnectionLock = (workspaceName: string | null) => {
  if (!workspaceName) {
    return
  }

  const existing = readConnectionLock(workspaceName)
  if (existing?.owner === tabSessionId) {
    window.localStorage.removeItem(getConnectionLockKey(workspaceName))
  }
}

const claimConnectionLock = (workspaceName: string) => {
  if (isWorkspaceNameTakenByOther(workspaceName)) {
    return false
  }

  writeConnectionLock(workspaceName)
  return true
}

const startLockHeartbeat = () => {
  if (lockHeartbeatTimer !== null) {
    window.clearInterval(lockHeartbeatTimer)
  }

  lockHeartbeatTimer = window.setInterval(() => {
    if (connectedWorkspaceName && isConnected) {
      writeConnectionLock(connectedWorkspaceName)
    }
  }, lockHeartbeatMs)
}

const stopLockHeartbeat = () => {
  if (lockHeartbeatTimer !== null) {
    window.clearInterval(lockHeartbeatTimer)
    lockHeartbeatTimer = null
  }
}

const readSettingsFromForm = (): UartSettings => ({
  baudRate: parseNumber(baudRateEl.value, defaultUartSettings.baudRate),
  dataBits: parseDataBits(dataBitsEl.value),
  stopBits: parseStopBits(stopBitsEl.value),
  parity: parseParity(parityEl.value),
  flowControl: parseFlowControl(flowControlEl.value),
  bufferSize: Math.max(255, parseNumber(bufferSizeEl.value, defaultUartSettings.bufferSize)),
})

const applySettingsToForm = (settings: UartSettings) => {
  baudRateEl.value = String(settings.baudRate)
  dataBitsEl.value = String(settings.dataBits)
  stopBitsEl.value = String(settings.stopBits)
  parityEl.value = settings.parity
  flowControlEl.value = settings.flowControl
  bufferSizeEl.value = String(settings.bufferSize)
}

const loadWorkspaceSettings = (workspaceName: string) => {
  const raw = window.localStorage.getItem(getWorkspaceStorageKey(workspaceName))
  if (!raw) {
    applySettingsToForm(defaultUartSettings)
    return
  }

  try {
    const parsed = JSON.parse(raw) as Partial<UartSettings>
    const safeSettings: UartSettings = {
      baudRate: parseNumber(parsed.baudRate, defaultUartSettings.baudRate),
      dataBits: parseDataBits(parsed.dataBits),
      stopBits: parseStopBits(parsed.stopBits),
      parity: parseParity(parsed.parity),
      flowControl: parseFlowControl(parsed.flowControl),
      bufferSize: Math.max(255, parseNumber(parsed.bufferSize, defaultUartSettings.bufferSize)),
    }
    applySettingsToForm(safeSettings)
  } catch {
    applySettingsToForm(defaultUartSettings)
  }
}

const saveWorkspaceSettings = (workspaceName: string) => {
  const settings = readSettingsFromForm()
  window.localStorage.setItem(getWorkspaceStorageKey(workspaceName), JSON.stringify(settings))
}

const pickNextWorkspaceName = () => {
  for (let i = 1; i <= 999; i += 1) {
    const candidate = normalizeUartName(`uart-${i}`)
    const hasSavedSettings = window.localStorage.getItem(getWorkspaceStorageKey(candidate)) !== null
    const hasLock = readConnectionLock(candidate) !== null

    if (candidate !== uartWorkspaceName && !hasSavedSettings && !hasLock) {
      return candidate
    }
  }

  return normalizeUartName(`uart-${Date.now()}`)
}

const openWorkspaceInNewTab = () => {
  const nextWorkspaceName = pickNextWorkspaceName()
  const newUrl = getWorkspacePath(nextWorkspaceName)
  window.open(newUrl, '_blank', 'noopener')
}

const appendToLog = (text: string) => {
  rxLogEl.textContent += text

  if (rxLogEl.textContent.length > maxLogChars) {
    rxLogEl.textContent = rxLogEl.textContent.slice(-maxLogChars)
  }

  if (autoScrollEl.checked) {
    rxLogEl.scrollTop = rxLogEl.scrollHeight
  }
}

const toggleExportMenu = (show: boolean) => {
  exportMenuEl.classList.toggle('hidden', !show)
  exportMenuEl.setAttribute('aria-hidden', String(!show))
}

const closeExportMenu = () => {
  toggleExportMenu(false)
}

const getLogText = () => rxLogEl.textContent ?? ''

const sanitizeDownloadName = (name: string) =>
  normalizeUartName(name || uartWorkspaceName)

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

const copyLogToClipboard = async () => {
  const logText = getLogText()

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(logText)
    } else {
      const fallbackTextArea = document.createElement('textarea')
      fallbackTextArea.value = logText
      fallbackTextArea.style.position = 'fixed'
      fallbackTextArea.style.opacity = '0'
      document.body.appendChild(fallbackTextArea)
      fallbackTextArea.focus()
      fallbackTextArea.select()
      document.execCommand('copy')
      fallbackTextArea.remove()
    }

    setStatus('log copied to clipboard')
  } catch (error) {
    setStatus(`copy failed: ${(error as Error).message}`)
  }
}

const exportLogAsTxt = () => {
  const logText = getLogText()
  const filename = `${sanitizeDownloadName(uartWorkspaceName)}-${getTimestampSuffix()}.txt`
  downloadBlob(new Blob([logText], { type: 'text/plain;charset=utf-8' }), filename)
  setStatus(`exported ${filename}`)
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
    .replace(/[^	\x20-\x7e]/g, '?')

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

  const pageCount = pages.length
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const pageLines = pages[pageIndex]
    const contentParts: string[] = []
    contentParts.push('BT')
    contentParts.push(`/F1 ${fontSize} Tf`)
    contentParts.push(`${lineHeight} TL`)
    contentParts.push(`1 0 0 1 ${margin} ${pageHeight - margin - fontSize} Tm`)
    contentParts.push(`(${escapePdfText(title)}) Tj`)
    contentParts.push('T*')
    contentParts.push(`(${escapePdfText('-'.repeat(90))}) Tj`)
    contentParts.push('T*')

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
    .map((offset, index) => (index === 0 ? '0000000000 65535 f ' : `${String(offset).padStart(10, '0')} 00000 n `))
    .join('\n')

  const pdf = [
    header,
    ...body,
    `xref\n0 ${objects.length + 1}\n${xrefEntries}\n`,
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogIndex} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`,
  ].join('')

  return new Blob([pdf], { type: 'application/pdf' })
}

const exportLogAsPdf = () => {
  const logText = getLogText()
  const filename = `${sanitizeDownloadName(uartWorkspaceName)}-${getTimestampSuffix()}.pdf`
  const bodyLines = wrapLogTextForPdf(logText, 100)
  const pdfBlob = buildSimplePdf(`UART Log - ${uartWorkspaceName}`, bodyLines)

  downloadBlob(pdfBlob, filename)
  setStatus(`exported ${filename}`)
}

const sanitizeRxText = (text: string) => text.replaceAll(ansiEscapeRegex, '')

const setStatus = (extraMessage?: string) => {
  const statusLines = [
    `uart name : ${uartWorkspaceName}`,
    isConnected && connectedBaudRate
      ? `connected - ${connectedBaudRate}`
      : 'disconnected',
  ]

  if (extraMessage) {
    statusLines.push(extraMessage)
  }

  statusEl.textContent = statusLines.join('\n')
}

const updateButtons = (connected: boolean) => {
  connectBtn.disabled = connected
  disconnectBtn.disabled = !connected
  sendBtn.disabled = !connected
}

const toggleSettings = (show: boolean) => {
  settingsPanelEl.classList.toggle('hidden', !show)
  settingsPanelEl.setAttribute('aria-hidden', String(!show))
}

const toggleTxPanel = () => {
  const willShow = txPanelEl.classList.contains('collapsed')
  txPanelEl.classList.toggle('collapsed', !willShow)
  txPanelEl.setAttribute('aria-hidden', String(!willShow))
  toggleTxBtn.textContent = willShow ? 'Hide TX' : 'Show TX'
}

const applyWorkspaceName = () => {
  if (isConnected) {
    setStatus('disconnect first before changing uart name')
    window.alert('Disconnect first, then change UART name.')
    return
  }

  saveWorkspaceSettings(uartWorkspaceName)
  const nextName = normalizeUartName(uartNameInputEl.value)

  if (isWorkspaceNameTakenByOther(nextName)) {
    setStatus(`uart name ${nextName} is in use, use another name`)
    window.alert(`UART name "${nextName}" is currently in use. Please choose another name.`)
    return
  }

  uartWorkspaceName = nextName
  uartNameInputEl.value = nextName
  navigateToWorkspace(nextName)
  loadWorkspaceSettings(nextName)
  setStatus()
}

const readLoop = async () => {
  if (!serialPort?.readable) {
    return
  }

  isReading = true

  try {
    while (serialPort?.readable && isReading) {
      reader = serialPort.readable.getReader()

      try {
        while (isReading) {
          const { value, done } = await reader.read()

          if (done) {
            break
          }

          if (value) {
            const decoded = textDecoder.decode(value, { stream: true })
            appendToLog(sanitizeRxText(decoded))
          }
        }
      } finally {
        reader.releaseLock()
        reader = null
      }
    }
  } catch (error) {
    appendToLog(`\n[Read error] ${(error as Error).message}\n`)
    setStatus('read error')
  }
}

const connect = async () => {
  if (!navigator.serial) {
    setStatus('Web Serial API is not available in this browser')
    return
  }

  if (!claimConnectionLock(uartWorkspaceName)) {
    setStatus(`uart name ${uartWorkspaceName} is in use, use another name`)
    window.alert(`UART name "${uartWorkspaceName}" is currently in use. Please choose another name.`)
    return
  }

  try {
    setStatus('waiting for port selection')
    serialPort = await navigator.serial.requestPort()

    const baudRate = Number(baudRateEl.value)
    const dataBits = parseDataBits(dataBitsEl.value)
    const stopBits = parseStopBits(stopBitsEl.value)
    const parity = parseParity(parityEl.value)
    const flowControl = parseFlowControl(flowControlEl.value)
    const bufferSize = Number(bufferSizeEl.value)

    await serialPort.open({
      baudRate,
      dataBits,
      stopBits,
      parity,
      flowControl,
      bufferSize,
    })

    updateButtons(true)
    isConnected = true
    connectedWorkspaceName = uartWorkspaceName
    connectedBaudRate = baudRate
    startLockHeartbeat()
    setStatus()
    appendToLog('\n[Connected]\n')

    void readLoop()
  } catch (error) {
    releaseConnectionLock(uartWorkspaceName)
    serialPort = null
    isConnected = false
    connectedWorkspaceName = null
    connectedBaudRate = null
    updateButtons(false)
    setStatus(`connect failed: ${(error as Error).message}`)
  }
}

const disconnect = async () => {
  isReading = false

  try {
    await reader?.cancel()
  } catch {
    // Ignore cancellation errors during disconnect.
  }

  try {
    await serialPort?.close()
  } catch {
    // Ignore close errors and continue cleanup.
  }

  serialPort = null
  reader = null
  isConnected = false
  connectedBaudRate = null
  stopLockHeartbeat()
  releaseConnectionLock(connectedWorkspaceName)
  connectedWorkspaceName = null
  appendToLog('\n[Disconnected]\n')
  setStatus()
  updateButtons(false)
}

const sendText = async () => {
  if (!serialPort?.writable) {
    return
  }

  const payload = txInputEl.value + lineEndingEl.value
  const writer = serialPort.writable.getWriter()

  try {
    await writer.write(textEncoder.encode(payload))
  } catch (error) {
    setStatus(`send failed: ${(error as Error).message}`)
  } finally {
    writer.releaseLock()
  }
}

connectBtn.addEventListener('click', () => {
  void connect()
})

newTabBtn.addEventListener('click', () => {
  openWorkspaceInNewTab()
})

applyNameBtn.addEventListener('click', () => {
  applyWorkspaceName()
})

uartNameInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    applyWorkspaceName()
  }
})

openSettingsBtn.addEventListener('click', () => {
  toggleSettings(true)
})

toggleTxBtn.addEventListener('click', () => {
  toggleTxPanel()
})

copyLogBtn.addEventListener('click', () => {
  void copyLogToClipboard()
})

exportTxtBtn.addEventListener('click', () => {
  exportLogAsTxt()
})

exportPdfBtn.addEventListener('click', () => {
  exportLogAsPdf()
})

exportBtn.addEventListener('click', (event) => {
  event.stopPropagation()
  const shouldShow = exportMenuEl.classList.contains('hidden')
  toggleExportMenu(shouldShow)
})

document.addEventListener('click', (event) => {
  if (!exportMenuEl.contains(event.target as Node) && event.target !== exportBtn) {
    closeExportMenu()
  }
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeExportMenu()
  }
})

closeSettingsBtn.addEventListener('click', () => {
  toggleSettings(false)
})

disconnectBtn.addEventListener('click', () => {
  void disconnect()
})

clearBtn.addEventListener('click', () => {
  rxLogEl.textContent = ''
})

sendBtn.addEventListener('click', () => {
  void sendText()
})

txInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    void sendText()
  }
})

if (!navigator.serial) {
  setStatus('Web Serial unsupported. Use Chrome or Edge on desktop.')
} else {
  const { hadPathSegment, workspaceName } = getWorkspaceNameFromPath(window.location.pathname)
  uartWorkspaceName = workspaceName
  uartNameInputEl.value = workspaceName
  if (!hadPathSegment || window.location.pathname !== getWorkspacePath(workspaceName)) {
    navigateToWorkspace(workspaceName)
  }
  loadWorkspaceSettings(workspaceName)
  setStatus()
}

const persistSettingEvents: Array<'change' | 'input'> = ['change', 'input']
for (const eventName of persistSettingEvents) {
  baudRateEl.addEventListener(eventName, () => saveWorkspaceSettings(uartWorkspaceName))
  dataBitsEl.addEventListener(eventName, () => saveWorkspaceSettings(uartWorkspaceName))
  stopBitsEl.addEventListener(eventName, () => saveWorkspaceSettings(uartWorkspaceName))
  parityEl.addEventListener(eventName, () => saveWorkspaceSettings(uartWorkspaceName))
  flowControlEl.addEventListener(eventName, () => saveWorkspaceSettings(uartWorkspaceName))
  bufferSizeEl.addEventListener(eventName, () => saveWorkspaceSettings(uartWorkspaceName))
}

window.addEventListener('popstate', () => {
  if (isConnected) {
    navigateToWorkspace(uartWorkspaceName, false)
    setStatus('disconnect first before changing uart path')
    return
  }

  saveWorkspaceSettings(uartWorkspaceName)
  const { hadPathSegment, workspaceName } = getWorkspaceNameFromPath(window.location.pathname)

  if (isWorkspaceNameTakenByOther(workspaceName)) {
    window.alert(`UART name "${workspaceName}" is currently in use. Please choose another name.`)
    navigateToWorkspace(uartWorkspaceName)
    return
  }

  uartWorkspaceName = workspaceName
  uartNameInputEl.value = workspaceName
  if (!hadPathSegment || window.location.pathname !== getWorkspacePath(workspaceName)) {
    navigateToWorkspace(workspaceName)
  }
  loadWorkspaceSettings(workspaceName)
  setStatus()
})

window.addEventListener('beforeunload', () => {
  stopLockHeartbeat()
  releaseConnectionLock(connectedWorkspaceName)
})

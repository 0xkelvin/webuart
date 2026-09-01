import './style.css'
import {
  connectSerialSession,
  disconnectSerialSession,
  runSerialReadLoop,
  writeSerialBytes,
  writeSerialText,
} from './serialService'
import { createPaneStore } from './paneStore'
import { getShareApiBase, getShareWsBase } from './shareConfig'
import {
  createFlashSession,
  defaultFlashBaud,
  detectChip as flashDetectChip,
  disconnectFlashSession,
  flashBaudRates,
  flashFirmware,
  formatAddress as formatFlashAddress,
  formatFileSize as formatFlashFileSize,
  normalizeChipName,
  requestFlashPort,
  type FlashChipInfo,
  type FlashFile,
  type FlashSession,
  type FlashTerminal,
} from './flashService'
import {
  applyConfig as runApplyConfig,
  closePortSafely as closeConfigPort,
  parseJsonConfig,
  requestConfigPort,
  type ApplyConfigProgress,
  type ConfigLogger,
  type EndCommand,
  type ResetMode,
} from './configService'
import {
  extractFirmwareZip,
  type FirmwareFileEntry,
  type FirmwareFlashParams,
  type FirmwareZipSummary,
} from './zipArtifact'

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

type QuickCommand = {
  id: string
  label: string
  value: string
  format: 'ascii' | 'hex'
  appendLineEnding: boolean
}

type TimerCommand = {
  id: string
  label: string
  value: string
  format: 'ascii' | 'hex'
  appendLineEnding: boolean
  intervalMs: number
}

type ShareStatus = 'idle' | 'creating' | 'sharing' | 'error'
type ShareViewerState = 'waiting' | 'connected'

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
  quickCommandsExpanded: boolean
  timerCommandsExpanded: boolean
  quickCommands: QuickCommand[]
  timerCommands: TimerCommand[]
  activeTimerCommandId: string | null
  activeTimerHandle: number | null
  timerSendBusy: boolean
  shareStatus: ShareStatus
  shareViewerState: ShareViewerState
  shareSessionId: string | null
  shareUrl: string | null
  shareError: string | null
  shareSocket: WebSocket | null
  sharePingHandle: number | null
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

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('Failed to initialize app root')
}

app.innerHTML = `
  <div class="socialDock" aria-label="Project links">
    <a
      class="socialLink"
      href="https://github.com/0xkelvin/webuart/tree/main"
      target="_blank"
      rel="noreferrer noopener"
      aria-label="Open the webuart GitHub repository"
      title="Open the webuart GitHub repository"
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M8 0C3.58 0 0 3.58 0 8.02c0 3.54 2.29 6.54 5.47 7.59.4.07.55-.17.55-.38v-1.32c-2.22.48-2.69-1.07-2.69-1.07-.36-.93-.87-1.17-.87-1.17-.71-.49.05-.48.05-.48.78.06 1.19.81 1.19.81.7 1.2 1.84.85 2.29.65.07-.51.27-.85.49-1.04-1.74-.2-3.57-.87-3.57-3.86 0-.85.3-1.55.79-2.1-.08-.2-.34-1.01.08-2.1 0 0 .65-.21 2.14.8.62-.17 1.28-.26 1.94-.26s1.32.09 1.94.26c1.49-1.01 2.14-.8 2.14-.8.42 1.09.16 1.9.08 2.1.49.55.79 1.25.79 2.1 0 2.99-1.83 3.66-3.58 3.86.28.24.53.72.53 1.45v2.15c0 .21.15.46.55.38A8.02 8.02 0 0 0 16 8.02C16 3.58 12.42 0 8 0Z"
        />
      </svg>
    </a>
    <a
      class="socialLink"
      href="https://www.linkedin.com/in/viet-bluleap-ai/"
      target="_blank"
      rel="noreferrer noopener"
      aria-label="Open LinkedIn profile"
      title="Open LinkedIn profile"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.44-2.13 2.94v5.67H9.35V9h3.42v1.56h.05c.48-.91 1.65-1.85 3.39-1.85 3.62 0 4.29 2.38 4.29 5.47v6.27ZM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14ZM7.12 20.45H3.56V9h3.56v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0Z"
        />
      </svg>
    </a>
  </div>
  <main class="layout">
    <nav class="appTabs" role="tablist" aria-label="Application sections">
      <button
        id="terminalTabBtn"
        class="appTab active"
        type="button"
        role="tab"
        aria-selected="true"
        aria-controls="terminalView"
        data-tab="terminal"
      >
        <span class="appTabIcon" aria-hidden="true">▣</span>
        <span class="appTabLabel">Terminal</span>
      </button>
      <button
        id="flashTabBtn"
        class="appTab"
        type="button"
        role="tab"
        aria-selected="false"
        aria-controls="flashView"
        data-tab="flash"
      >
        <span class="appTabIcon" aria-hidden="true">⚡</span>
        <span class="appTabLabel">Flash</span>
      </button>
      <button
        id="configTabBtn"
        class="appTab"
        type="button"
        role="tab"
        aria-selected="false"
        aria-controls="configView"
        data-tab="config"
      >
        <span class="appTabIcon" aria-hidden="true">⚙</span>
        <span class="appTabLabel">Config</span>
      </button>
    </nav>

    <section id="firstOpenTip" class="tip card hidden" aria-hidden="true">
      <div>
        <strong>Split tip:</strong> right-click inside any pane to split vertically or horizontally. Max 6 panes.
      </div>
      <div>
        Layout persistence is planned as a premium feature.
      </div>
      <button id="dismissTipBtn" class="ghost" type="button">Got it</button>
    </section>

    <section
      id="terminalView"
      class="tabPanel terminalView"
      role="tabpanel"
      aria-labelledby="terminalTabBtn"
    >
      <section id="splitRoot" class="splitRoot"></section>
    </section>

    <section
      id="flashView"
      class="tabPanel flashView hidden"
      role="tabpanel"
      aria-labelledby="flashTabBtn"
      aria-hidden="true"
    >
      <div class="flashLayout">
        <header class="flashHeader card">
          <div class="flashHeaderRow">
            <h2 class="flashTitle">ESP32-S3 Firmware Flasher</h2>
            <div class="flashHeaderMeta">
              <label class="flashInlineField">
                <span>Baud</span>
                <select id="flashBaud">
                  ${flashBaudRates
                    .map(
                      (rate) =>
                        `<option value="${rate}" ${rate === defaultFlashBaud ? 'selected' : ''}>${rate.toLocaleString()}</option>`,
                    )
                    .join('')}
                </select>
              </label>
              <label class="flashInlineField flashCheckField" title="Erase the entire flash chip first (slow). Off matches flash-radar.bat.">
                <input id="flashEraseAll" type="checkbox" />
                <span>Erase entire chip</span>
              </label>
              <label class="flashInlineField flashCheckField" title="Compress data over UART (faster). On matches flash-radar.bat.">
                <input id="flashCompress" type="checkbox" checked />
                <span>Compress</span>
              </label>
            </div>
          </div>
          <p class="flashHelp" id="flashStatus">
            Load the firmware <code>.zip</code> below, then Connect → Detect chip → Flash.
            Flash addresses come from the artifact itself (<code>flasher_args.json</code>, else
            <code>partition-table.bin</code>) — never from hardcoded offsets.
          </p>
          <p class="flashBootHint">
            <strong>Tip:</strong> if Detect chip fails, hold <kbd>BOOT</kbd>, tap <kbd>RESET</kbd>,
            release <kbd>BOOT</kbd>, then retry.
          </p>
        </header>

        <section class="flashFilesCard card">
          <div class="flashFilesHeader">
            <h3>Firmware files</h3>
            <div class="flashFilesActions">
              <label
                class="primary mini flashZipLabel"
                for="flashZipInput"
                title="Load a CI artifact zip (bootloader.bin, partition-table.bin, ota_data_initial.bin, the app .bin, and ideally flasher_args.json)"
              >📦 Load firmware .zip</label>
              <input id="flashZipInput" type="file" accept=".zip,application/zip,application/x-zip-compressed" hidden />
              <button id="flashClearZipBtn" class="ghost mini" type="button" disabled>Clear</button>
            </div>
          </div>
          <p id="flashZipStatus" class="flashZipStatus" aria-live="polite">
            Load a <code>.zip</code> from your CI build (e.g. <code>gm_radar-wifi-1.zip</code>).
            Addresses are read from the build's own flash map, so layout changes are picked up
            automatically.
          </p>
          <div id="flashPlan" class="flashPlan hidden" aria-live="polite"></div>
        </section>

        <section class="flashActionsCard card">
          <div class="flashActionsRow">
            <button id="flashConnectBtn" class="primary" type="button">Connect</button>
            <button id="flashDisconnectBtn" class="ghost" type="button" disabled>Disconnect</button>
            <button id="flashDetectBtn" class="ghost" type="button" disabled>Detect chip</button>
            <button id="flashStartBtn" class="primary flashStartBtn" type="button" disabled>⚡ Flash</button>
          </div>
          <div id="flashChipInfo" class="flashChipInfo hidden" aria-live="polite"></div>
          <div id="flashProgress" class="flashProgress hidden" aria-live="polite">
            <div class="flashProgressLabel">
              <span id="flashProgressMessage">Idle</span>
              <span id="flashProgressPercent">0%</span>
            </div>
            <div class="flashProgressBar">
              <div id="flashProgressFill" class="flashProgressFill" style="width: 0%"></div>
            </div>
          </div>
        </section>

        <section class="flashConsoleCard card">
          <div class="flashConsoleHeader">
            <h3>Console</h3>
            <div class="flashConsoleActions">
              <button id="flashCopyLogBtn" class="ghost mini" type="button">Copy</button>
              <button id="flashClearLogBtn" class="ghost mini" type="button">Clear</button>
            </div>
          </div>
          <pre id="flashConsoleOutput" class="flashConsoleOutput" aria-live="polite"></pre>
        </section>
      </div>
    </section>

    <section
      id="configView"
      class="tabPanel configView hidden"
      role="tabpanel"
      aria-labelledby="configTabBtn"
      aria-hidden="true"
    >
      <div class="flashLayout configLayout">
        <header class="flashHeader configHeader card">
          <div class="flashHeaderRow">
            <h2 class="flashTitle">⚙ Device Configuration</h2>
            <div class="flashHeaderMeta">
              <label class="flashInlineField">
                <span>Baud</span>
                <select id="configBaudSelect"></select>
              </label>
              <label class="flashInlineField" title="How the device is reset before entering AT mode.">
                <span>Reset</span>
                <select id="configResetSelect">
                  <option value="rts_dtr" selected>RTS+DTR</option>
                  <option value="dtr">DTR only</option>
                  <option value="usb_jtag">USB-JTAG (S3)</option>
                  <option value="none">Manual</option>
                </select>
              </label>
              <label class="flashInlineField" title="Final AT command after all keys are written.">
                <span>After</span>
                <select id="configEndSelect">
                  <option value="cont" selected>AT+CONT</option>
                  <option value="rst">AT+RST=</option>
                </select>
              </label>
            </div>
          </div>
          <p class="flashHelp">
            Send a JSON config to a running ESP32-S3 firmware over UART. Mirrors
            <code>configure_device.py</code> (AT-mode protocol, 115200 baud).
          </p>
          <p class="flashBootHint configBootHint">
            <strong>Tip:</strong> the board must be running normal firmware (not the bootloader),
            and no Terminal pane may hold the same port.
          </p>
        </header>

        <section class="flashFilesCard configFilesCard card">
          <div class="flashFilesHeader">
            <h3>Config JSON</h3>
            <div class="flashFilesActions">
              <label class="ghost mini configFileLabel" for="configFileInput">Load JSON file</label>
              <input id="configFileInput" type="file" accept="application/json,.json" hidden />
              <button id="configClearJsonBtn" class="ghost mini" type="button">Clear</button>
            </div>
          </div>
          <div class="configFilenameRow">
            <label class="flashInlineField configFilenameControl">
              <span>CFGFILE</span>
              <input
                id="configFilenameInput"
                class="configFilenameInput"
                type="text"
                placeholder="config_vitalSign_office.json"
                autocomplete="off"
                spellcheck="false"
              />
            </label>
            <span id="configJsonStatus" class="configJsonStatus" aria-live="polite"></span>
          </div>
          <textarea
            id="configJsonEditor"
            class="configJsonEditor"
            spellcheck="false"
            autocomplete="off"
            placeholder='{
  "WIFISSID": "MyWifi",
  "WIFIPWD": "secret",
  "MQTTADD": "143.198.199.16",
  "MQTTPRT": 1883,
  ...
}'
          ></textarea>
        </section>

        <section class="flashActionsCard configActionsCard card">
          <div class="flashActionsRow">
            <button id="configConnectBtn" class="primary" type="button">Connect</button>
            <button id="configDisconnectBtn" class="ghost" type="button" disabled>Disconnect</button>
            <button id="configApplyBtn" class="primary configApplyBtn" type="button" disabled>
              ⚙ Apply configuration
            </button>
            <button id="configCancelBtn" class="ghost" type="button" hidden>Cancel</button>
          </div>
          <div id="configPortInfo" class="flashChipInfo configPortInfo hidden" aria-live="polite"></div>
          <div id="configStatus" class="flashProgress configStatus hidden" aria-live="polite">
            <div class="flashProgressLabel">
              <span id="configStatusMessage">Idle</span>
              <span id="configStatusPercent">0%</span>
            </div>
            <div class="flashProgressBar">
              <div id="configStatusFill" class="flashProgressFill" style="width: 0%"></div>
            </div>
          </div>
        </section>

        <section class="flashConsoleCard configConsoleCard card">
          <div class="flashConsoleHeader">
            <h3>Console</h3>
            <div class="flashConsoleActions">
              <button id="configCopyLogBtn" class="ghost mini" type="button">Copy</button>
              <button id="configClearLogBtn" class="ghost mini" type="button">Clear</button>
            </div>
          </div>
          <pre id="configConsoleOutput" class="flashConsoleOutput" aria-live="polite"></pre>
        </section>
      </div>
    </section>
  </main>

  <div id="paneMenu" class="paneMenu hidden" aria-hidden="true">
    <button class="menuItem" data-menu-action="copy" type="button">Copy</button>
    <button class="menuItem" data-menu-action="split-vertical" type="button">Split vertical</button>
    <button class="menuItem" data-menu-action="split-horizontal" type="button">Split horizontal</button>
    <button class="menuItem" data-menu-action="close-pane" type="button">Close pane</button>
  </div>

  <div id="quickCommandMenu" class="paneMenu hidden" aria-hidden="true">
    <button class="menuItem" data-quick-menu-action="edit" type="button">Edit command</button>
    <button class="menuItem" data-quick-menu-action="delete" type="button">Delete command</button>
  </div>

  <div id="timerCommandMenu" class="paneMenu hidden" aria-hidden="true">
    <button class="menuItem" data-timer-menu-action="edit" type="button">Edit timer</button>
    <button class="menuItem" data-timer-menu-action="delete" type="button">Delete timer</button>
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

  <section id="quickCommandPanel" class="quickCommandPanel hidden" aria-hidden="true">
    <div class="quickCommandDialog card">
      <div class="settingsHeader">
        <h2 id="quickCommandTitle">Add Quick Command</h2>
        <button id="closeQuickCommandBtn" class="ghost" type="button">Close</button>
      </div>
      <div class="quickCommandForm">
        <label>
          Name
          <input id="quickCommandName" type="text" maxlength="40" placeholder="Reset" />
        </label>
        <label>
          Command
          <textarea id="quickCommandValue" rows="3" placeholder="AT+RST"></textarea>
        </label>
        <p id="quickCommandHelp" class="quickCmdFormHelp">ASCII mode sends plain text.</p>
        <div class="quickCmdFormRow">
          <label>
            Format
            <select id="quickCommandFormat">
              <option value="ascii" selected>ASCII</option>
              <option value="hex">HEX</option>
            </select>
          </label>
          <label class="quickCmdToggleLabel">
            <input id="quickCommandAppendLineEnding" type="checkbox" checked />
            <span>Append selected line ending</span>
          </label>
        </div>
        <p id="quickCommandPreview" class="quickCmdFormPreview" aria-live="polite"></p>
        <p id="quickCommandError" class="quickCmdFormError hidden" aria-live="polite"></p>
      </div>
      <div class="settingsActions">
        <button id="deleteQuickCommandBtn" class="ghost hidden" type="button">Delete</button>
        <button id="cancelQuickCommandBtn" class="ghost" type="button">Cancel</button>
        <button id="saveQuickCommandBtn" class="primary" type="button" disabled>Add</button>
      </div>
    </div>
  </section>

  <section id="timerCommandPanel" class="quickCommandPanel hidden" aria-hidden="true">
    <div class="quickCommandDialog card">
      <div class="settingsHeader">
        <h2 id="timerCommandTitle">Add Timer Command</h2>
        <button id="closeTimerCommandBtn" class="ghost" type="button">Close</button>
      </div>
      <div class="quickCommandForm">
        <label>
          Name
          <input id="timerCommandName" type="text" maxlength="40" placeholder="Heartbeat" />
        </label>
        <label>
          Command
          <textarea id="timerCommandValue" rows="3" placeholder="AT"></textarea>
        </label>
        <p id="timerCommandHelp" class="quickCmdFormHelp">ASCII mode sends plain text.</p>
        <div class="quickCmdFormRow">
          <label>
            Format
            <select id="timerCommandFormat">
              <option value="ascii" selected>ASCII</option>
              <option value="hex">HEX</option>
            </select>
          </label>
          <label class="quickCmdToggleLabel">
            <input id="timerCommandAppendLineEnding" type="checkbox" checked />
            <span>Append selected line ending</span>
          </label>
        </div>
        <label>
          Interval (ms)
          <input id="timerCommandInterval" type="number" min="200" max="3600000" step="1" value="1000" />
        </label>
        <p id="timerCommandPreview" class="quickCmdFormPreview" aria-live="polite"></p>
        <p id="timerCommandError" class="quickCmdFormError hidden" aria-live="polite"></p>
      </div>
      <div class="settingsActions">
        <button id="deleteTimerCommandBtn" class="ghost hidden" type="button">Delete</button>
        <button id="cancelTimerCommandBtn" class="ghost" type="button">Cancel</button>
        <button id="saveTimerCommandBtn" class="primary" type="button" disabled>Add</button>
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
const maxQuickCommandsPerPane = 16
const maxTimerCommandsPerPane = 12
const minTimerIntervalMs = 200
const maxTimerIntervalMs = 3_600_000
const warnFastTimerThresholdMs = 500
const sharePingIntervalMs = 30_000
const shareInitialHistoryChars = 80_000
const txInputMaxHeightPx = 132
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
const createQuickCommandId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `qc-${Date.now()}-${Math.random().toString(16).slice(2)}`
const createTimerCommandId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `tm-${Date.now()}-${Math.random().toString(16).slice(2)}`

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
const terminalTabBtn = document.querySelector<HTMLButtonElement>('#terminalTabBtn')
const flashTabBtn = document.querySelector<HTMLButtonElement>('#flashTabBtn')
const terminalViewEl = document.querySelector<HTMLElement>('#terminalView')
const flashViewEl = document.querySelector<HTMLElement>('#flashView')
const flashBaudEl = document.querySelector<HTMLSelectElement>('#flashBaud')
const flashEraseAllEl = document.querySelector<HTMLInputElement>('#flashEraseAll')
const flashCompressEl = document.querySelector<HTMLInputElement>('#flashCompress')
const flashZipInputEl = document.querySelector<HTMLInputElement>('#flashZipInput')
const flashClearZipBtn = document.querySelector<HTMLButtonElement>('#flashClearZipBtn')
const flashZipStatusEl = document.querySelector<HTMLElement>('#flashZipStatus')
const flashPlanEl = document.querySelector<HTMLElement>('#flashPlan')
const flashConnectBtn = document.querySelector<HTMLButtonElement>('#flashConnectBtn')
const flashDisconnectBtn = document.querySelector<HTMLButtonElement>('#flashDisconnectBtn')
const flashDetectBtn = document.querySelector<HTMLButtonElement>('#flashDetectBtn')
const flashStartBtn = document.querySelector<HTMLButtonElement>('#flashStartBtn')
const flashChipInfoEl = document.querySelector<HTMLElement>('#flashChipInfo')
const flashProgressEl = document.querySelector<HTMLElement>('#flashProgress')
const flashProgressMessageEl = document.querySelector<HTMLElement>('#flashProgressMessage')
const flashProgressPercentEl = document.querySelector<HTMLElement>('#flashProgressPercent')
const flashProgressFillEl = document.querySelector<HTMLElement>('#flashProgressFill')
const flashConsoleOutputEl = document.querySelector<HTMLElement>('#flashConsoleOutput')
const flashCopyLogBtn = document.querySelector<HTMLButtonElement>('#flashCopyLogBtn')
const flashClearLogBtn = document.querySelector<HTMLButtonElement>('#flashClearLogBtn')
const flashStatusEl = document.querySelector<HTMLElement>('#flashStatus')
const configTabBtn = document.querySelector<HTMLButtonElement>('#configTabBtn')
const configViewEl = document.querySelector<HTMLElement>('#configView')
const configBaudSelect = document.querySelector<HTMLSelectElement>('#configBaudSelect')
const configResetSelect = document.querySelector<HTMLSelectElement>('#configResetSelect')
const configEndSelect = document.querySelector<HTMLSelectElement>('#configEndSelect')
const configFileInput = document.querySelector<HTMLInputElement>('#configFileInput')
const configClearJsonBtn = document.querySelector<HTMLButtonElement>('#configClearJsonBtn')
const configFilenameInput = document.querySelector<HTMLInputElement>('#configFilenameInput')
const configJsonEditor = document.querySelector<HTMLTextAreaElement>('#configJsonEditor')
const configJsonStatusEl = document.querySelector<HTMLElement>('#configJsonStatus')
const configConnectBtn = document.querySelector<HTMLButtonElement>('#configConnectBtn')
const configDisconnectBtn = document.querySelector<HTMLButtonElement>('#configDisconnectBtn')
const configApplyBtn = document.querySelector<HTMLButtonElement>('#configApplyBtn')
const configCancelBtn = document.querySelector<HTMLButtonElement>('#configCancelBtn')
const configPortInfoEl = document.querySelector<HTMLElement>('#configPortInfo')
const configStatusEl = document.querySelector<HTMLElement>('#configStatus')
const configStatusMessageEl = document.querySelector<HTMLElement>('#configStatusMessage')
const configStatusPercentEl = document.querySelector<HTMLElement>('#configStatusPercent')
const configStatusFillEl = document.querySelector<HTMLElement>('#configStatusFill')
const configConsoleOutputEl = document.querySelector<HTMLElement>('#configConsoleOutput')
const configCopyLogBtn = document.querySelector<HTMLButtonElement>('#configCopyLogBtn')
const configClearLogBtn = document.querySelector<HTMLButtonElement>('#configClearLogBtn')
const paneMenuEl = document.querySelector<HTMLDivElement>('#paneMenu')
const quickCommandMenuEl = document.querySelector<HTMLDivElement>('#quickCommandMenu')
const timerCommandMenuEl = document.querySelector<HTMLDivElement>('#timerCommandMenu')
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
const quickCommandPanelEl = document.querySelector<HTMLElement>('#quickCommandPanel')
const quickCommandTitleEl = document.querySelector<HTMLElement>('#quickCommandTitle')
const closeQuickCommandBtn = document.querySelector<HTMLButtonElement>('#closeQuickCommandBtn')
const cancelQuickCommandBtn = document.querySelector<HTMLButtonElement>('#cancelQuickCommandBtn')
const saveQuickCommandBtn = document.querySelector<HTMLButtonElement>('#saveQuickCommandBtn')
const deleteQuickCommandBtn = document.querySelector<HTMLButtonElement>('#deleteQuickCommandBtn')
const quickCommandNameEl = document.querySelector<HTMLInputElement>('#quickCommandName')
const quickCommandValueEl = document.querySelector<HTMLTextAreaElement>('#quickCommandValue')
const quickCommandFormatEl = document.querySelector<HTMLSelectElement>('#quickCommandFormat')
const quickCommandAppendLineEndingEl = document.querySelector<HTMLInputElement>(
  '#quickCommandAppendLineEnding',
)
const quickCommandHelpEl = document.querySelector<HTMLElement>('#quickCommandHelp')
const quickCommandPreviewEl = document.querySelector<HTMLElement>('#quickCommandPreview')
const quickCommandErrorEl = document.querySelector<HTMLElement>('#quickCommandError')
const timerCommandPanelEl = document.querySelector<HTMLElement>('#timerCommandPanel')
const timerCommandTitleEl = document.querySelector<HTMLElement>('#timerCommandTitle')
const closeTimerCommandBtn = document.querySelector<HTMLButtonElement>('#closeTimerCommandBtn')
const cancelTimerCommandBtn = document.querySelector<HTMLButtonElement>('#cancelTimerCommandBtn')
const saveTimerCommandBtn = document.querySelector<HTMLButtonElement>('#saveTimerCommandBtn')
const deleteTimerCommandBtn = document.querySelector<HTMLButtonElement>('#deleteTimerCommandBtn')
const timerCommandNameEl = document.querySelector<HTMLInputElement>('#timerCommandName')
const timerCommandValueEl = document.querySelector<HTMLTextAreaElement>('#timerCommandValue')
const timerCommandFormatEl = document.querySelector<HTMLSelectElement>('#timerCommandFormat')
const timerCommandAppendLineEndingEl = document.querySelector<HTMLInputElement>(
  '#timerCommandAppendLineEnding',
)
const timerCommandIntervalEl = document.querySelector<HTMLInputElement>('#timerCommandInterval')
const timerCommandHelpEl = document.querySelector<HTMLElement>('#timerCommandHelp')
const timerCommandPreviewEl = document.querySelector<HTMLElement>('#timerCommandPreview')
const timerCommandErrorEl = document.querySelector<HTMLElement>('#timerCommandError')

if (
  !splitRootEl ||
  !terminalTabBtn ||
  !flashTabBtn ||
  !terminalViewEl ||
  !flashViewEl ||
  !flashBaudEl ||
  !flashEraseAllEl ||
  !flashCompressEl ||
  !flashZipInputEl ||
  !flashClearZipBtn ||
  !flashZipStatusEl ||
  !flashPlanEl ||
  !flashConnectBtn ||
  !flashDisconnectBtn ||
  !flashDetectBtn ||
  !flashStartBtn ||
  !flashChipInfoEl ||
  !flashProgressEl ||
  !flashProgressMessageEl ||
  !flashProgressPercentEl ||
  !flashProgressFillEl ||
  !flashConsoleOutputEl ||
  !flashCopyLogBtn ||
  !flashClearLogBtn ||
  !flashStatusEl ||
  !configTabBtn ||
  !configViewEl ||
  !configBaudSelect ||
  !configResetSelect ||
  !configEndSelect ||
  !configFileInput ||
  !configClearJsonBtn ||
  !configFilenameInput ||
  !configJsonEditor ||
  !configJsonStatusEl ||
  !configConnectBtn ||
  !configDisconnectBtn ||
  !configApplyBtn ||
  !configCancelBtn ||
  !configPortInfoEl ||
  !configStatusEl ||
  !configStatusMessageEl ||
  !configStatusPercentEl ||
  !configStatusFillEl ||
  !configConsoleOutputEl ||
  !configCopyLogBtn ||
  !configClearLogBtn ||
  !paneMenuEl ||
  !quickCommandMenuEl ||
  !timerCommandMenuEl ||
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
  !bufferSizeEl ||
  !quickCommandPanelEl ||
  !quickCommandTitleEl ||
  !closeQuickCommandBtn ||
  !cancelQuickCommandBtn ||
  !saveQuickCommandBtn ||
  !deleteQuickCommandBtn ||
  !quickCommandNameEl ||
  !quickCommandValueEl ||
  !quickCommandFormatEl ||
  !quickCommandAppendLineEndingEl ||
  !quickCommandHelpEl ||
  !quickCommandPreviewEl ||
  !quickCommandErrorEl ||
  !timerCommandPanelEl ||
  !timerCommandTitleEl ||
  !closeTimerCommandBtn ||
  !cancelTimerCommandBtn ||
  !saveTimerCommandBtn ||
  !deleteTimerCommandBtn ||
  !timerCommandNameEl ||
  !timerCommandValueEl ||
  !timerCommandFormatEl ||
  !timerCommandAppendLineEndingEl ||
  !timerCommandIntervalEl ||
  !timerCommandHelpEl ||
  !timerCommandPreviewEl ||
  !timerCommandErrorEl
) {
  throw new Error('Failed to locate required UI elements')
}

let flashControlsReady = false
const refreshFlashControlsIfReady = () => {
  if (flashControlsReady) {
    refreshFlashControls()
  }
  // Config tab also needs to know when a terminal pane connects/disconnects,
  // because it shares the serial port lock with Terminal/Flash.
  if (configControlsReady) {
    refreshConfigControls()
  }
}

let paneIdCounter = 0
let splitIdCounter = 0
const panes = createPaneStore<PaneState>()
const splitRatios = new Map<string, number>()
let activePaneId = ''
let rootNode: PaneTreeNode
let menuPaneId: string | null = null
let quickCommandMenuPaneId: string | null = null
let quickCommandMenuCommandId: string | null = null
let timerCommandMenuPaneId: string | null = null
let timerCommandMenuCommandId: string | null = null
let optionsOpenPaneId: string | null = null
let settingsPaneId: string | null = null
let quickCommandPaneId: string | null = null
let quickCommandEditId: string | null = null
let timerCommandPaneId: string | null = null
let timerCommandEditId: string | null = null
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
  quickCommandsExpanded: false,
  timerCommandsExpanded: false,
  quickCommands: [],
  timerCommands: [],
  activeTimerCommandId: null,
  activeTimerHandle: null,
  timerSendBusy: false,
  shareStatus: 'idle',
  shareViewerState: 'waiting',
  shareSessionId: null,
  shareUrl: null,
  shareError: null,
  shareSocket: null,
  sharePingHandle: null,
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
  const pane = panes.mutate(paneId, (currentPane) => {
    currentPane.rxLog += text
    if (currentPane.rxLog.length > maxLogChars) {
      currentPane.rxLog = currentPane.rxLog.slice(-maxLogChars)
    }
  })
  if (!pane) {
    return
  }

  const terminalEl = splitRootEl.querySelector<HTMLElement>(`.terminal[data-pane-id="${paneId}"]`)
  if (!terminalEl) {
    return
  }
  terminalEl.textContent = pane.rxLog
  if (pane.autoScroll) {
    terminalEl.scrollTop = terminalEl.scrollHeight
  }

  broadcastPaneShareData(paneId, text)
}

const autoSizeTxInput = (textArea: HTMLTextAreaElement) => {
  textArea.style.height = 'auto'
  const nextHeight = Math.min(textArea.scrollHeight, txInputMaxHeightPx)
  textArea.style.height = `${nextHeight}px`
  textArea.style.overflowY = textArea.scrollHeight > txInputMaxHeightPx ? 'auto' : 'hidden'
}

const setPaneStatus = (paneId: string, message: string) => {
  const pane = panes.mutate(paneId, (currentPane) => {
    currentPane.statusMessage = message
  })
  if (!pane) {
    return
  }
  render()
}

const clearPaneShareSocket = (pane: PaneState) => {
  if (pane.sharePingHandle !== null) {
    window.clearInterval(pane.sharePingHandle)
    pane.sharePingHandle = null
  }
  if (pane.shareSocket) {
    pane.shareSocket.onopen = null
    pane.shareSocket.onmessage = null
    pane.shareSocket.onclose = null
    pane.shareSocket.onerror = null
    try {
      pane.shareSocket.close()
    } catch {
      // Ignore socket close errors during cleanup.
    }
    pane.shareSocket = null
  }
}

const stopPaneSharing = (paneId: string, statusMessage?: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  clearPaneShareSocket(pane)
  panes.markShareIdle(
    paneId,
    statusMessage
      ? {
          statusMessage,
        }
      : undefined,
  )
  render()
}

const copyShareLink = async (paneId: string) => {
  const pane = panes.get(paneId)
  if (!pane?.shareUrl) {
    return
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(pane.shareUrl)
    } else {
      const fallbackTextArea = document.createElement('textarea')
      fallbackTextArea.value = pane.shareUrl
      fallbackTextArea.style.position = 'fixed'
      fallbackTextArea.style.opacity = '0'
      document.body.appendChild(fallbackTextArea)
      fallbackTextArea.focus()
      fallbackTextArea.select()
      const copied = document.execCommand('copy')
      fallbackTextArea.remove()
      if (!copied) {
        throw new Error('copy command was rejected')
      }
    }
    pane.statusMessage = 'share link copied'
    render()
  } catch (error) {
    pane.statusMessage = `copy share link failed: ${error instanceof Error ? error.message : 'unknown error'}`
    render()
  }
}

const broadcastPaneShareData = (paneId: string, payload: string) => {
  const pane = panes.get(paneId)
  if (!pane || pane.shareStatus !== 'sharing' || !pane.shareSocket) {
    return
  }
  if (pane.shareSocket.readyState !== WebSocket.OPEN) {
    return
  }
  try {
    pane.shareSocket.send(JSON.stringify({ type: 'data', payload }))
  } catch {
    panes.markShareError(paneId, {
      error: 'share relay send failed',
      clearSession: false,
    })
    clearPaneShareSocket(pane)
    render()
  }
}

const startPaneSharing = async (paneId: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  if (!pane.isConnected) {
    pane.statusMessage = 'connect first to share session'
    render()
    return
  }
  if (pane.shareStatus === 'creating' || pane.shareStatus === 'sharing') {
    return
  }

  clearPaneShareSocket(pane)
  panes.markShareCreating(paneId, {
    statusMessage: 'creating share link...',
  })
  render()

  try {
    const response = await fetch(`${getShareApiBase()}/api/sessions`, {
      method: 'POST',
    })
    const body = (await response.json().catch(() => ({}))) as {
      sessionId?: string
      hostToken?: string
      error?: string
    }

    if (!response.ok || !body.sessionId || !body.hostToken) {
      throw new Error(body.error ?? 'failed to create session')
    }

    const wsUrl = `${getShareWsBase()}/api/sessions/${body.sessionId}/ws?role=host`
    const ws = new WebSocket(wsUrl)

    panes.setShareSession(paneId, {
      sessionId: body.sessionId,
      shareUrl: `${window.location.origin}/viewer.html?s=${encodeURIComponent(body.sessionId)}`,
      shareSocket: ws,
      statusMessage: 'authenticating share session...',
    })
    render()

    ws.onopen = () => {
      const current = panes.get(paneId)
      if (!current || current.shareSocket !== ws) {
        return
      }
      ws.send(JSON.stringify({ type: 'auth', token: body.hostToken }))
    }

    ws.onmessage = (event) => {
      const current = panes.get(paneId)
      if (!current || current.shareSocket !== ws) {
        return
      }
      let message: {
        type?: string
        message?: string
        newToken?: string
      }
      try {
        message = JSON.parse(String(event.data)) as typeof message
      } catch {
        return
      }

      if (message.type === 'auth_ok') {
        panes.markShareReady(paneId, {
          statusMessage: 'share link ready',
        })
        if (current.sharePingHandle !== null) {
          window.clearInterval(current.sharePingHandle)
        }
        current.sharePingHandle = window.setInterval(() => {
          const livePane = panes.get(paneId)
          if (!livePane || livePane.shareSocket !== ws || ws.readyState !== WebSocket.OPEN) {
            return
          }
          ws.send(JSON.stringify({ type: 'ping' }))
        }, sharePingIntervalMs)

        const history = current.rxLog.slice(-shareInitialHistoryChars)
        if (history) {
          ws.send(JSON.stringify({ type: 'data', payload: history }))
        }
        render()
        return
      }

      if (message.type === 'viewer_connected') {
        panes.setShareViewerState(paneId, {
          viewerState: 'connected',
          statusMessage: 'viewer connected',
        })
        render()
        return
      }

      if (message.type === 'viewer_disconnected') {
        panes.setShareViewerState(paneId, {
          viewerState: 'waiting',
          statusMessage: 'viewer disconnected',
        })
        render()
        return
      }

      if (message.type === 'session_closed') {
        stopPaneSharing(paneId, 'share session closed')
        return
      }

      if (message.type === 'error') {
        panes.markShareError(paneId, {
          error: message.message ?? 'share session error',
        })
        clearPaneShareSocket(current)
        render()
      }
    }

    ws.onclose = () => {
      const current = panes.get(paneId)
      if (!current || current.shareSocket !== ws) {
        return
      }
      clearPaneShareSocket(current)
      if (current.shareStatus !== 'error') {
        panes.markShareIdle(paneId)
      }
      render()
    }

    ws.onerror = () => {
      const current = panes.get(paneId)
      if (!current || current.shareSocket !== ws) {
        return
      }
      panes.markShareError(paneId, {
        error: 'share connection failed',
      })
      clearPaneShareSocket(current)
      render()
    }
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : 'failed to create share session'
    const shareError =
      rawMessage === 'Failed to fetch'
        ? 'sharing service is unreachable (run worker:dev)'
        : rawMessage
    panes.markShareError(paneId, {
      error: shareError,
    })
    clearPaneShareSocket(pane)
    render()
  }
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

  if (pane.shareStatus === 'creating' || pane.shareStatus === 'sharing') {
    stopPaneSharing(paneId)
  }

  if (pane.activeTimerHandle !== null) {
    window.clearInterval(pane.activeTimerHandle)
    panes.markTimerStopped(paneId)
  }

  await disconnectSerialSession(pane)

  releaseConnectionLock(pane.connectedUartName)

  panes.markDisconnected(paneId)
  if (appendNote) {
    appendPaneLog(paneId, '\n[Disconnected]\n')
  }

  updateHeartbeat()
  render()
  refreshFlashControlsIfReady()
}

const readLoop = async (paneId: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }

  await runSerialReadLoop(pane, {
    onChunk: (chunk) => {
      appendPaneLog(paneId, sanitizeRxText(textDecoder.decode(chunk, { stream: true })))
    },
    onError: (errorMessage) => {
      appendPaneLog(paneId, `\n[Read error] ${errorMessage}\n`)
      setPaneStatus(paneId, 'read error')
    },
  })
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
    const selectedPort = await connectSerialSession(pane, {
      serial: navigator.serial,
      settings: {
        baudRate: pane.settings.baudRate,
        dataBits: pane.settings.dataBits,
        stopBits: pane.settings.stopBits,
        parity: pane.settings.parity,
        flowControl: pane.settings.flowControl,
        bufferSize: pane.settings.bufferSize,
      },
    })

    if (isPortAlreadyUsed(selectedPort, paneId)) {
      await disconnectSerialSession(pane)
      releaseConnectionLock(pane.uartName)
      pane.statusMessage = 'this serial port is already connected in another pane'
      render()
      window.alert('This serial port is already connected in another pane.')
      return
    }

    panes.markConnected(paneId, {
      baudRate: pane.settings.baudRate,
      uartName: pane.uartName,
    })
    appendPaneLog(paneId, '\n[Connected]\n')

    updateHeartbeat()
    render()
    refreshFlashControlsIfReady()
    void readLoop(paneId)
  } catch (error) {
    releaseConnectionLock(pane.uartName)
    await disconnectSerialSession(pane)
    panes.markConnectFailed(paneId, {
      statusMessage: `connect failed: ${(error as Error).message}`,
    })
    render()
  }
}

const sendPaneText = async (paneId: string) => {
  const pane = panes.get(paneId)
  if (!pane?.serialPort?.writable) {
    return
  }

  try {
    await writeSerialText(pane, pane.txInput + pane.lineEnding, textEncoder)
  } catch (error) {
    pane.statusMessage = `send failed: ${(error as Error).message}`
    render()
  }
}

const concatUint8Arrays = (chunks: Uint8Array[]) => {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

const parseHexPayload = (raw: string): Uint8Array | null => {
  const normalized = raw.replace(/0x/gi, '').replace(/\s+/g, '')
  if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
    return null
  }

  const bytes = new Uint8Array(normalized.length / 2)
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16)
  }
  return bytes
}

const toHexString = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, '0').toUpperCase()).join(' ')

const escapeControlChars = (value: string) =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')

const getCommandPayloadBytes = (
  command: Pick<QuickCommand, 'value' | 'format' | 'appendLineEnding'>,
  lineEnding: PaneState['lineEnding'],
) => {
  const lineEndingSuffix = command.appendLineEnding ? lineEnding : ''

  if (command.format === 'hex') {
    const payload = parseHexPayload(command.value)
    if (!payload) {
      return null
    }
    const suffixBytes = lineEndingSuffix ? textEncoder.encode(lineEndingSuffix) : new Uint8Array()
    return concatUint8Arrays([payload, suffixBytes])
  }

  return textEncoder.encode(command.value + lineEndingSuffix)
}

const sendCommandPayload = async (
  paneId: string,
  command: Pick<QuickCommand, 'label' | 'value' | 'format' | 'appendLineEnding'>,
  origin: 'quick' | 'timer',
  showSuccessStatus = true,
) => {
  const pane = panes.get(paneId)
  if (!pane || !pane.serialPort?.writable) {
    return false
  }

  const bytes = getCommandPayloadBytes(command, pane.lineEnding)
  if (!bytes) {
    pane.statusMessage = `${origin} command ${command.label} has invalid HEX`
    render()
    return false
  }

  try {
    await writeSerialBytes(pane, bytes)
    if (showSuccessStatus) {
      pane.statusMessage = `sent ${origin} command ${command.label}`
      render()
    }
    return true
  } catch (error) {
    pane.statusMessage = `send failed: ${(error as Error).message}`
    render()
    return false
  }
}

const stopPaneTimer = (paneId: string, statusMessage?: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }

  if (pane.activeTimerHandle !== null) {
    window.clearInterval(pane.activeTimerHandle)
  }
  panes.markTimerStopped(
    paneId,
    statusMessage
      ? {
          statusMessage,
        }
      : undefined,
  )
  render()
}

const runPaneTimerTick = async (paneId: string, commandId: string) => {
  const pane = panes.get(paneId)
  if (!pane || pane.activeTimerCommandId !== commandId) {
    return
  }
  if (!pane.isConnected || !pane.serialPort?.writable) {
    stopPaneTimer(paneId, 'timer auto-stopped: disconnected')
    return
  }
  if (pane.timerSendBusy) {
    return
  }

  const command = pane.timerCommands.find((item) => item.id === commandId)
  if (!command) {
    stopPaneTimer(paneId, 'timer command missing')
    return
  }

  panes.setTimerSendBusy(paneId, { busy: true })
  const ok = await sendCommandPayload(paneId, command, 'timer', false)
  panes.setTimerSendBusy(paneId, { busy: false })
  if (!ok) {
    stopPaneTimer(paneId, `timer stopped: ${command.label} send failed`)
  }
}

const startPaneTimer = (paneId: string, commandId: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  if (!pane.isConnected || !pane.serialPort?.writable) {
    pane.statusMessage = 'connect first to start timer'
    render()
    return
  }

  const command = pane.timerCommands.find((item) => item.id === commandId)
  if (!command) {
    return
  }

  if (command.intervalMs < warnFastTimerThresholdMs) {
    const confirmed = window.confirm(
      `Timer interval ${command.intervalMs}ms is very fast and may flood your device. Continue?`,
    )
    if (!confirmed) {
      return
    }
  }

  if (pane.activeTimerHandle !== null) {
    window.clearInterval(pane.activeTimerHandle)
    panes.markTimerStopped(paneId)
  }

  const timerHandle = window.setInterval(() => {
    void runPaneTimerTick(paneId, command.id)
  }, command.intervalMs)
  panes.markTimerStarted(paneId, {
    commandId: command.id,
    handle: timerHandle,
    statusMessage: `timer started: ${command.label} every ${command.intervalMs}ms`,
  })
  render()
}

const sendQuickCommand = async (paneId: string, commandId: string) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  if (!pane.serialPort?.writable) {
    pane.statusMessage = 'connect first to send quick command'
    render()
    return
  }

  const command = pane.quickCommands.find((item) => item.id === commandId)
  if (!command) {
    return
  }

  await sendCommandPayload(paneId, command, 'quick', true)
}

const updateQuickCommandPreview = () => {
  if (!quickCommandPaneId) {
    quickCommandPreviewEl.textContent = ''
    return
  }

  const pane = panes.get(quickCommandPaneId)
  if (!pane) {
    quickCommandPreviewEl.textContent = ''
    return
  }

  const value = quickCommandValueEl.value
  const format: QuickCommand['format'] = quickCommandFormatEl.value === 'hex' ? 'hex' : 'ascii'
  const command = {
    value,
    format,
    appendLineEnding: quickCommandAppendLineEndingEl.checked,
  }

  if (!value.trim()) {
    quickCommandPreviewEl.textContent = 'Preview: enter a command to see bytes.'
    return
  }

  const payload = getCommandPayloadBytes(command, pane.lineEnding)
  if (!payload) {
    quickCommandPreviewEl.textContent = 'Preview: HEX is invalid.'
    return
  }

  if (command.format === 'hex') {
    quickCommandPreviewEl.textContent = `Preview bytes: ${toHexString(payload) || '(none)'}`
    return
  }

  const previewText = value + (command.appendLineEnding ? pane.lineEnding : '')
  quickCommandPreviewEl.textContent = `Preview string: "${escapeControlChars(previewText)}" | bytes: ${toHexString(payload) || '(none)'}`
}

const updateQuickCommandFormHelp = () => {
  if (quickCommandFormatEl.value === 'hex') {
    quickCommandHelpEl.textContent = 'HEX mode: use byte pairs like AA 0D 0A.'
    return
  }
  quickCommandHelpEl.textContent = 'ASCII mode sends plain text.'
}

const validateQuickCommandForm = () => {
  const label = quickCommandNameEl.value.trim()
  const value = quickCommandValueEl.value
  let errorMessage = ''

  if (!label) {
    errorMessage = 'Name is required.'
  } else if (!value.trim()) {
    errorMessage = 'Command is required.'
  } else if (quickCommandFormatEl.value === 'hex' && !parseHexPayload(value)) {
    errorMessage = 'HEX must contain full byte pairs (example: AA 0D 0A).'
  }

  quickCommandErrorEl.textContent = errorMessage
  quickCommandErrorEl.classList.toggle('hidden', !errorMessage)
  saveQuickCommandBtn.disabled = Boolean(errorMessage)
  updateQuickCommandPreview()
}

const closeQuickCommandModal = () => {
  quickCommandPaneId = null
  quickCommandEditId = null
  quickCommandPanelEl.classList.add('hidden')
  quickCommandPanelEl.setAttribute('aria-hidden', 'true')
}

const openQuickCommandModal = (paneId: string, commandId: string | null) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  if (!commandId && pane.quickCommands.length >= maxQuickCommandsPerPane) {
    pane.statusMessage = `max ${maxQuickCommandsPerPane} quick commands reached`
    render()
    return
  }

  const command = commandId ? pane.quickCommands.find((item) => item.id === commandId) : null
  if (commandId && !command) {
    return
  }

  quickCommandPaneId = paneId
  quickCommandEditId = command?.id ?? null
  hideQuickCommandMenu()
  hideTimerCommandMenu()

  quickCommandTitleEl.textContent = command ? 'Edit Quick Command' : 'Add Quick Command'
  saveQuickCommandBtn.textContent = command ? 'Save' : 'Add'
  deleteQuickCommandBtn.classList.toggle('hidden', !command)

  quickCommandNameEl.value = command?.label ?? ''
  quickCommandValueEl.value = command?.value ?? ''
  quickCommandFormatEl.value = command?.format ?? 'ascii'
  quickCommandAppendLineEndingEl.checked = command?.appendLineEnding ?? true

  updateQuickCommandFormHelp()
  updateQuickCommandPreview()
  validateQuickCommandForm()

  quickCommandPanelEl.classList.remove('hidden')
  quickCommandPanelEl.setAttribute('aria-hidden', 'false')
  window.setTimeout(() => quickCommandNameEl.focus(), 0)
}

const saveQuickCommandFromModal = () => {
  if (!quickCommandPaneId) {
    return
  }

  const pane = panes.get(quickCommandPaneId)
  if (!pane) {
    closeQuickCommandModal()
    return
  }

  validateQuickCommandForm()
  if (saveQuickCommandBtn.disabled) {
    return
  }

  const nextCommand: Omit<QuickCommand, 'id'> = {
    label: quickCommandNameEl.value.trim(),
    value: quickCommandValueEl.value,
    format: quickCommandFormatEl.value === 'hex' ? 'hex' : 'ascii',
    appendLineEnding: quickCommandAppendLineEndingEl.checked,
  }

  if (quickCommandEditId) {
    const commandIndex = pane.quickCommands.findIndex((item) => item.id === quickCommandEditId)
    if (commandIndex < 0) {
      closeQuickCommandModal()
      return
    }
    panes.replaceQuickCommand(quickCommandPaneId, quickCommandEditId, {
      ...pane.quickCommands[commandIndex],
      ...nextCommand,
    })
    pane.statusMessage = `updated quick command ${nextCommand.label}`
  } else {
    panes.addQuickCommand(quickCommandPaneId, {
      id: createQuickCommandId(),
      ...nextCommand,
    })
    pane.statusMessage = `added quick command ${nextCommand.label}`
  }

  closeQuickCommandModal()
  render()
}

const deleteQuickCommand = (paneId: string, commandId: string, closeModal = false) => {
  const pane = panes.get(paneId)
  if (!pane) {
    if (closeModal) {
      closeQuickCommandModal()
    }
    return
  }

  const removed = panes.removeQuickCommand(paneId, commandId)
  if (!removed) {
    if (closeModal) {
      closeQuickCommandModal()
    }
    return
  }

  pane.statusMessage = `deleted quick command ${removed.label}`
  if (closeModal) {
    closeQuickCommandModal()
  }
  render()
}

const deleteQuickCommandFromModal = () => {
  if (!quickCommandPaneId || !quickCommandEditId) {
    return
  }
  deleteQuickCommand(quickCommandPaneId, quickCommandEditId, true)
}

const updateTimerCommandPreview = () => {
  if (!timerCommandPaneId) {
    timerCommandPreviewEl.textContent = ''
    return
  }

  const pane = panes.get(timerCommandPaneId)
  if (!pane) {
    timerCommandPreviewEl.textContent = ''
    return
  }

  const value = timerCommandValueEl.value
  const intervalMs = parseNumber(timerCommandIntervalEl.value, NaN)
  const format: QuickCommand['format'] = timerCommandFormatEl.value === 'hex' ? 'hex' : 'ascii'
  const command = {
    value,
    format,
    appendLineEnding: timerCommandAppendLineEndingEl.checked,
  }

  if (!value.trim()) {
    timerCommandPreviewEl.textContent = 'Preview: enter a command to see bytes.'
    return
  }

  const payload = getCommandPayloadBytes(command, pane.lineEnding)
  if (!payload) {
    timerCommandPreviewEl.textContent = 'Preview: HEX is invalid.'
    return
  }

  const intervalText = Number.isFinite(intervalMs) ? `${Math.round(intervalMs)}ms` : 'invalid interval'
  if (command.format === 'hex') {
    timerCommandPreviewEl.textContent = `Every ${intervalText}: ${toHexString(payload) || '(none)'}`
    return
  }

  const previewText = value + (command.appendLineEnding ? pane.lineEnding : '')
  timerCommandPreviewEl.textContent = `Every ${intervalText}: "${escapeControlChars(previewText)}" | bytes: ${toHexString(payload) || '(none)'}`
}

const updateTimerCommandFormHelp = () => {
  if (timerCommandFormatEl.value === 'hex') {
    timerCommandHelpEl.textContent = 'HEX mode: use byte pairs like AA 0D 0A.'
    return
  }
  timerCommandHelpEl.textContent = 'ASCII mode sends plain text.'
}

const validateTimerCommandForm = () => {
  const label = timerCommandNameEl.value.trim()
  const value = timerCommandValueEl.value
  const intervalMs = Math.round(parseNumber(timerCommandIntervalEl.value, NaN))
  let errorMessage = ''

  if (!label) {
    errorMessage = 'Name is required.'
  } else if (!value.trim()) {
    errorMessage = 'Command is required.'
  } else if (timerCommandFormatEl.value === 'hex' && !parseHexPayload(value)) {
    errorMessage = 'HEX must contain full byte pairs (example: AA 0D 0A).'
  } else if (!Number.isFinite(intervalMs)) {
    errorMessage = 'Interval is required.'
  } else if (intervalMs < minTimerIntervalMs || intervalMs > maxTimerIntervalMs) {
    errorMessage = `Interval must be between ${minTimerIntervalMs} and ${maxTimerIntervalMs} ms.`
  }

  timerCommandErrorEl.textContent = errorMessage
  timerCommandErrorEl.classList.toggle('hidden', !errorMessage)
  saveTimerCommandBtn.disabled = Boolean(errorMessage)
  updateTimerCommandPreview()
}

const closeTimerCommandModal = () => {
  timerCommandPaneId = null
  timerCommandEditId = null
  timerCommandPanelEl.classList.add('hidden')
  timerCommandPanelEl.setAttribute('aria-hidden', 'true')
}

const openTimerCommandModal = (paneId: string, commandId: string | null) => {
  const pane = panes.get(paneId)
  if (!pane) {
    return
  }
  if (!commandId && pane.timerCommands.length >= maxTimerCommandsPerPane) {
    pane.statusMessage = `max ${maxTimerCommandsPerPane} timer commands reached`
    render()
    return
  }

  const command = commandId ? pane.timerCommands.find((item) => item.id === commandId) : null
  if (commandId && !command) {
    return
  }

  timerCommandPaneId = paneId
  timerCommandEditId = command?.id ?? null
  hideTimerCommandMenu()
  hideQuickCommandMenu()

  timerCommandTitleEl.textContent = command ? 'Edit Timer Command' : 'Add Timer Command'
  saveTimerCommandBtn.textContent = command ? 'Save' : 'Add'
  deleteTimerCommandBtn.classList.toggle('hidden', !command)

  timerCommandNameEl.value = command?.label ?? ''
  timerCommandValueEl.value = command?.value ?? ''
  timerCommandFormatEl.value = command?.format ?? 'ascii'
  timerCommandAppendLineEndingEl.checked = command?.appendLineEnding ?? true
  timerCommandIntervalEl.value = String(command?.intervalMs ?? 1000)

  updateTimerCommandFormHelp()
  updateTimerCommandPreview()
  validateTimerCommandForm()

  timerCommandPanelEl.classList.remove('hidden')
  timerCommandPanelEl.setAttribute('aria-hidden', 'false')
  window.setTimeout(() => timerCommandNameEl.focus(), 0)
}

const saveTimerCommandFromModal = () => {
  if (!timerCommandPaneId) {
    return
  }

  const pane = panes.get(timerCommandPaneId)
  if (!pane) {
    closeTimerCommandModal()
    return
  }

  validateTimerCommandForm()
  if (saveTimerCommandBtn.disabled) {
    return
  }

  const nextCommand: Omit<TimerCommand, 'id'> = {
    label: timerCommandNameEl.value.trim(),
    value: timerCommandValueEl.value,
    format: timerCommandFormatEl.value === 'hex' ? 'hex' : 'ascii',
    appendLineEnding: timerCommandAppendLineEndingEl.checked,
    intervalMs: Math.round(parseNumber(timerCommandIntervalEl.value, 1000)),
  }

  if (timerCommandEditId) {
    const commandIndex = pane.timerCommands.findIndex((item) => item.id === timerCommandEditId)
    if (commandIndex < 0) {
      closeTimerCommandModal()
      return
    }
    const activeBeingEdited = pane.activeTimerCommandId === timerCommandEditId
    panes.replaceTimerCommand(timerCommandPaneId, timerCommandEditId, {
      ...pane.timerCommands[commandIndex],
      ...nextCommand,
    })
    pane.statusMessage = `updated timer command ${nextCommand.label}`
    if (activeBeingEdited) {
      startPaneTimer(timerCommandPaneId, timerCommandEditId)
    }
  } else {
    panes.addTimerCommand(timerCommandPaneId, {
      id: createTimerCommandId(),
      ...nextCommand,
    })
    pane.statusMessage = `added timer command ${nextCommand.label}`
  }

  closeTimerCommandModal()
  render()
}

const deleteTimerCommand = (paneId: string, commandId: string, closeModal = false) => {
  const pane = panes.get(paneId)
  if (!pane) {
    if (closeModal) {
      closeTimerCommandModal()
    }
    return
  }

  const removed = panes.removeTimerCommand(paneId, commandId)
  if (!removed) {
    if (closeModal) {
      closeTimerCommandModal()
    }
    return
  }

  if (pane.activeTimerCommandId === commandId) {
    stopPaneTimer(paneId)
  }
  pane.statusMessage = `deleted timer command ${removed.label}`
  if (closeModal) {
    closeTimerCommandModal()
  }
  render()
}

const deleteTimerCommandFromModal = () => {
  if (!timerCommandPaneId || !timerCommandEditId) {
    return
  }
  deleteTimerCommand(timerCommandPaneId, timerCommandEditId, true)
}

const manageQuickCommand = (paneId: string, commandId: string) => {
  openQuickCommandModal(paneId, commandId)
}

const manageTimerCommand = (paneId: string, commandId: string) => {
  openTimerCommandModal(paneId, commandId)
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
      const copied = document.execCommand('copy')
      fallbackTextArea.remove()
      if (!copied) {
        throw new Error('copy command was rejected')
      }
    }
    pane.statusMessage = 'log copied to clipboard'
    render()
  } catch (error) {
    pane.statusMessage = `copy failed: ${error instanceof Error ? error.message : 'unknown error'}`
    render()
  }
}

const copyPaneSelectionOrLog = async (paneId: string) => {
  const selection = window.getSelection()
  const selectedText = selection?.toString().trim() ?? ''
  if (selectedText) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(selectedText)
      } else {
        const fallbackTextArea = document.createElement('textarea')
        fallbackTextArea.value = selectedText
        fallbackTextArea.style.position = 'fixed'
        fallbackTextArea.style.opacity = '0'
        document.body.appendChild(fallbackTextArea)
        fallbackTextArea.focus()
        fallbackTextArea.select()
        const copied = document.execCommand('copy')
        fallbackTextArea.remove()
        if (!copied) {
          throw new Error('copy command was rejected')
        }
      }

      const pane = panes.get(paneId)
      if (!pane) {
        return
      }
      pane.statusMessage = 'selection copied to clipboard'
      render()
      return
    } catch (error) {
      const pane = panes.get(paneId)
      if (!pane) {
        return
      }
      pane.statusMessage = `copy failed: ${error instanceof Error ? error.message : 'unknown error'}`
      render()
      return
    }
  }

  await copyPaneLog(paneId)
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
    const activeTimerCommand = pane.activeTimerCommandId
      ? pane.timerCommands.find((command) => command.id === pane.activeTimerCommandId) ?? null
      : null
    const statusSegments = [`${escapeHtml(pane.uartName)}`, statusText]
    if (activeTimerCommand) {
      statusSegments.push(
        `timer on: ${escapeHtml(activeTimerCommand.label)} (${activeTimerCommand.intervalMs}ms)`,
      )
    }
    if (pane.shareStatus === 'creating') {
      statusSegments.push('sharing: creating link')
    } else if (pane.shareStatus === 'sharing') {
      statusSegments.push(
        pane.shareViewerState === 'connected' ? 'sharing: viewer connected' : 'sharing: waiting viewer',
      )
    } else if (pane.shareStatus === 'error' && pane.shareError) {
      statusSegments.push(`sharing error: ${escapeHtml(pane.shareError)}`)
    }
    if (pane.statusMessage && pane.statusMessage !== pane.shareError) {
      statusSegments.push(escapeHtml(pane.statusMessage))
    }

    return `
      <section class="pane ${isActive ? 'active' : ''}" data-pane-id="${pane.id}" tabindex="0">
        <header class="paneHeader">
          <div class="paneToolbar">
            <input class="paneNameInput" data-pane-id="${pane.id}" value="${escapeHtml(pane.uartName)}" maxlength="40" placeholder="uart-name" title="Click to rename" />
            <button class="ghost mini" data-action="settings" data-pane-id="${pane.id}" type="button" title="UART settings"><span class="btnIcon">⚙</span><span class="btnLabel"> Settings</span></button>
            <label class="txToggle" title="Show or hide TX panel">
              <input class="txToggleInput" data-pane-id="${pane.id}" type="checkbox" ${pane.txExpanded ? 'checked' : ''} />
              <span class="txToggleTrack" aria-hidden="true"><span class="txToggleThumb"></span></span>
              <span class="txToggleText">TX</span>
            </label>
            <div class="optionsControl" data-pane-id="${pane.id}">
              <button class="ghost mini" data-action="toggle-options" data-pane-id="${pane.id}" type="button" title="Options">⋯</button>
              <div class="optionsMenu ${isMenuOpen ? '' : 'hidden'}" aria-hidden="${String(!isMenuOpen)}">
                <button class="menuItem" data-action="copy-log" data-pane-id="${pane.id}" type="button">Copy Log</button>
                <button class="menuItem" data-action="export-txt" data-pane-id="${pane.id}" type="button">Export TXT</button>
                <button class="menuItem" data-action="export-pdf" data-pane-id="${pane.id}" type="button">Export PDF</button>
                <button class="menuItem" data-action="clear-log" data-pane-id="${pane.id}" type="button">Clear</button>
                ${pane.shareStatus === 'sharing' || pane.shareStatus === 'creating'
                  ? `<button class="menuItem" data-action="share-copy-link" data-pane-id="${pane.id}" type="button" ${pane.shareUrl ? '' : 'disabled'}>Copy Share Link</button>
                     <button class="menuItem" data-action="share-stop" data-pane-id="${pane.id}" type="button">Stop Sharing</button>`
                  : `<button class="menuItem" data-action="share-start" data-pane-id="${pane.id}" type="button" ${pane.isConnected ? '' : 'disabled'}>Start Sharing</button>`}
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
            ${pane.shareStatus === 'sharing' || pane.shareStatus === 'creating'
              ? `<button class="ghost mini shareQuickBtn" data-action="share-copy-link" data-pane-id="${pane.id}" type="button" ${pane.shareUrl ? '' : 'disabled'}><span class="btnLabel">Copy Link</span></button>`
              : ''}
          </div>
          <p class="paneStatus">${statusSegments.join(' | ')}</p>
        </header>
        <pre class="terminal" data-pane-id="${pane.id}" aria-live="polite" style="font-size: ${pane.terminalFontRem.toFixed(2)}rem; background: ${terminalTheme.bg}; color: ${terminalTheme.fg}; border-color: ${terminalTheme.border};">${escapeHtml(pane.rxLog)}</pre>
        <input class="terminalHiddenInput" data-pane-id="${pane.id}" type="password" aria-hidden="true" />
        <section class="txPanel ${pane.txExpanded ? '' : 'collapsed'}" aria-hidden="${String(!pane.txExpanded)}">
          <textarea class="txInput" data-pane-id="${pane.id}" rows="1" placeholder="Type and press Enter to send (Shift+Enter for new line)">${escapeHtml(pane.txInput)}</textarea>
          <div class="txRow">
            <label class="txLineEndingControl">
              <span class="txRowLabel">EOL</span>
              <select class="lineEnding txLineEndingSelect" data-pane-id="${pane.id}">
                <option value="" ${pane.lineEnding === '' ? 'selected' : ''}>none</option>
                <option value="\n" ${pane.lineEnding === '\n' ? 'selected' : ''}>LF (\\n)</option>
                <option value="\r\n" ${pane.lineEnding === '\r\n' ? 'selected' : ''}>CRLF (\\r\\n)</option>
                <option value="\r" ${pane.lineEnding === '\r' ? 'selected' : ''}>CR (\\r)</option>
              </select>
            </label>
            <div class="txInlineToggles" aria-label="TX section visibility">
              <label class="txInlineToggle" title="Show or hide quick commands">
                <input class="txInlineToggleInput quickCommandsToggleInput" data-pane-id="${pane.id}" type="checkbox" ${pane.quickCommandsExpanded ? 'checked' : ''} />
                <span class="txInlineToggleTrack" aria-hidden="true"><span class="txInlineToggleThumb"></span></span>
                <span class="txInlineToggleText">Quick Cmd</span>
              </label>
              <label class="txInlineToggle" title="Show or hide timer commands">
                <input class="txInlineToggleInput timerCommandsToggleInput" data-pane-id="${pane.id}" type="checkbox" ${pane.timerCommandsExpanded ? 'checked' : ''} />
                <span class="txInlineToggleTrack" aria-hidden="true"><span class="txInlineToggleThumb"></span></span>
                <span class="txInlineToggleText">Timer Cmd</span>
              </label>
            </div>
            <button class="primary txSendBtn" data-action="send" data-pane-id="${pane.id}" type="button" ${pane.isConnected ? '' : 'disabled'}>Send</button>
          </div>
          <div class="quickCmds ${pane.quickCommandsExpanded ? '' : 'collapsed'}" aria-label="Quick commands" aria-hidden="${String(!pane.quickCommandsExpanded)}">
            <div class="quickCmdsHeader">
              <span>Quick Cmd</span>
              <button class="ghost mini" data-action="quick-add" data-pane-id="${pane.id}" type="button">+ Add</button>
            </div>
            <div class="quickCmdsStrip" data-pane-id="${pane.id}">
              ${pane.quickCommands.length
                ? pane.quickCommands
                    .map(
                      (command) =>
                        `<button class="quickCmdChip" data-action="quick-send" data-pane-id="${pane.id}" data-command-id="${command.id}" type="button" title="${command.format.toUpperCase()} | ${escapeHtml(command.value)} | Right-click to edit">${escapeHtml(command.label)}</button>`,
                    )
                    .join('')
                : '<p class="quickCmdHint">No quick commands yet. Use + Add.</p>'}
            </div>
          </div>
          <div class="quickCmds ${pane.timerCommandsExpanded ? '' : 'collapsed'}" aria-label="Timer commands" aria-hidden="${String(!pane.timerCommandsExpanded)}">
            <div class="quickCmdsHeader">
              <span>Timer Cmd</span>
              <div class="timerActions">
                <button class="ghost mini" data-action="timer-add" data-pane-id="${pane.id}" type="button">+ Add</button>
                <button class="ghost mini" data-action="timer-stop" data-pane-id="${pane.id}" type="button" ${pane.activeTimerCommandId ? '' : 'disabled'}>Stop</button>
              </div>
            </div>
            <div class="quickCmdsStrip" data-pane-id="${pane.id}">
              ${pane.timerCommands.length
                ? pane.timerCommands
                    .map((command) => {
                      const isRunning = pane.activeTimerCommandId === command.id
                      return `<button class="quickCmdChip timerCmdChip ${isRunning ? 'isRunning' : ''}" data-action="timer-start" data-pane-id="${pane.id}" data-timer-command-id="${command.id}" type="button" title="${command.format.toUpperCase()} | ${escapeHtml(command.value)} | ${command.intervalMs}ms | Right-click to edit">${isRunning ? '● ' : ''}${escapeHtml(command.label)} (${command.intervalMs}ms)</button>`
                    })
                    .join('')
                : '<p class="quickCmdHint">No timer commands yet. Use + Add.</p>'}
            </div>
          </div>
        </section>
      </section>
    `
  }

  const ratio = splitRatios.get(node.splitId) ?? 0.5
  const firstRatio = Math.round(ratio * 1000) / 1000
  const secondRatio = Math.round((1 - ratio) * 1000) / 1000

  return `
    <section class="split ${node.orientation}" data-split-id="${node.splitId}">
      <div class="splitPane splitPaneFirst" style="flex: ${firstRatio} 1 0">
        ${renderNode(node.first)}
      </div>
      <div class="splitDivider ${node.orientation}" data-split-id="${node.splitId}" role="separator" aria-orientation="${node.orientation === 'vertical' ? 'vertical' : 'horizontal'}"></div>
      <div class="splitPane splitPaneSecond" style="flex: ${secondRatio} 1 0">
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

    const txInputEl = splitRootEl.querySelector<HTMLTextAreaElement>(
      `.txInput[data-pane-id="${pane.id}"]`,
    )
    if (txInputEl) {
      autoSizeTxInput(txInputEl)
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
  paneMenuEl.classList.remove('hidden')
  paneMenuEl.setAttribute('aria-hidden', 'false')
  positionPaneMenu(paneMenuEl, x, y)
}

const hidePaneMenu = () => {
  menuPaneId = null
  paneMenuEl.classList.add('hidden')
  paneMenuEl.setAttribute('aria-hidden', 'true')
}

const positionPaneMenu = (menuEl: HTMLElement, x: number, y: number) => {
  const viewportPadding = 8

  menuEl.style.left = `${x}px`
  menuEl.style.top = `${y}px`

  const rect = menuEl.getBoundingClientRect()
  const maxLeft = Math.max(viewportPadding, window.innerWidth - rect.width - viewportPadding)
  const maxTop = Math.max(viewportPadding, window.innerHeight - rect.height - viewportPadding)
  const left = Math.min(maxLeft, Math.max(viewportPadding, x))
  const top = Math.min(maxTop, Math.max(viewportPadding, y))

  menuEl.style.left = `${left}px`
  menuEl.style.top = `${top}px`
}

const showQuickCommandMenu = (x: number, y: number, paneId: string, commandId: string) => {
  quickCommandMenuPaneId = paneId
  quickCommandMenuCommandId = commandId
  quickCommandMenuEl.classList.remove('hidden')
  quickCommandMenuEl.setAttribute('aria-hidden', 'false')
  positionPaneMenu(quickCommandMenuEl, x, y)
}

const hideQuickCommandMenu = () => {
  quickCommandMenuPaneId = null
  quickCommandMenuCommandId = null
  quickCommandMenuEl.classList.add('hidden')
  quickCommandMenuEl.setAttribute('aria-hidden', 'true')
}

const showTimerCommandMenu = (x: number, y: number, paneId: string, commandId: string) => {
  timerCommandMenuPaneId = paneId
  timerCommandMenuCommandId = commandId
  timerCommandMenuEl.classList.remove('hidden')
  timerCommandMenuEl.setAttribute('aria-hidden', 'false')
  positionPaneMenu(timerCommandMenuEl, x, y)
}

const hideTimerCommandMenu = () => {
  timerCommandMenuPaneId = null
  timerCommandMenuCommandId = null
  timerCommandMenuEl.classList.add('hidden')
  timerCommandMenuEl.setAttribute('aria-hidden', 'true')
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const getSplitRatioBounds = (axisSize: number) => {
  const minPaneSizePx = 72
  if (axisSize <= 0) {
    return { minRatio: 0.5, maxRatio: 0.5 }
  }

  const minRatioFromSize = minPaneSizePx / axisSize
  const minRatio = clamp(minRatioFromSize, 0.05, 0.45)
  const maxRatio = 1 - minRatio

  return { minRatio, maxRatio }
}

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
  const axisSize = isRow ? rect.width : rect.height
  const { minRatio, maxRatio } = getSplitRatioBounds(axisSize)
  const ratio = clamp(rawRatio, minRatio, maxRatio)

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
    case 'share-start':
      optionsOpenPaneId = null
      await startPaneSharing(paneId)
      return
    case 'share-copy-link':
      optionsOpenPaneId = null
      await copyShareLink(paneId)
      return
    case 'share-stop':
      optionsOpenPaneId = null
      stopPaneSharing(paneId, 'sharing stopped')
      return
    case 'send':
      await sendPaneText(paneId)
      return
    case 'quick-add':
      openQuickCommandModal(paneId, null)
      return
    case 'timer-add':
      openTimerCommandModal(paneId, null)
      return
    case 'timer-stop':
      stopPaneTimer(paneId, 'timer stopped')
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
  const timerCommandButton = target.closest<HTMLButtonElement>(
    '.timerCmdChip[data-pane-id][data-timer-command-id]',
  )
  if (timerCommandButton) {
    event.preventDefault()
    const paneId = timerCommandButton.getAttribute('data-pane-id')
    const commandId = timerCommandButton.getAttribute('data-timer-command-id')
    if (!paneId || !commandId) {
      return
    }
    setPaneAsActive(paneId)
    hidePaneMenu()
    hideQuickCommandMenu()
    showTimerCommandMenu(event.clientX, event.clientY, paneId, commandId)
    return
  }

  const quickCommandButton = target.closest<HTMLButtonElement>(
    '.quickCmdChip[data-pane-id][data-command-id]',
  )
  if (quickCommandButton) {
    event.preventDefault()
    const paneId = quickCommandButton.getAttribute('data-pane-id')
    const commandId = quickCommandButton.getAttribute('data-command-id')
    if (!paneId || !commandId) {
      return
    }
    setPaneAsActive(paneId)
    hidePaneMenu()
    hideTimerCommandMenu()
    showQuickCommandMenu(event.clientX, event.clientY, paneId, commandId)
    return
  }

  hideQuickCommandMenu()
  hideTimerCommandMenu()

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
      autoSizeTxInput(target)
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
  if (
    target.matches('.quickCommandsToggleInput[data-pane-id]') &&
    target instanceof HTMLInputElement
  ) {
    const paneId = target.getAttribute('data-pane-id')
    const pane = paneId ? panes.get(paneId) : null
    if (pane) {
      pane.quickCommandsExpanded = target.checked
      render()
    }
    return
  }

  if (
    target.matches('.timerCommandsToggleInput[data-pane-id]') &&
    target instanceof HTMLInputElement
  ) {
    const paneId = target.getAttribute('data-pane-id')
    const pane = paneId ? panes.get(paneId) : null
    if (pane) {
      pane.timerCommandsExpanded = target.checked
      render()
    }
    return
  }

  if (target.matches('.txToggleInput[data-pane-id]') && target instanceof HTMLInputElement) {
    const paneId = target.getAttribute('data-pane-id')
    const pane = paneId ? panes.get(paneId) : null
    if (pane) {
      pane.txExpanded = target.checked
      optionsOpenPaneId = null
      render()
    }
    return
  }

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
    !event.shiftKey &&
    target.matches('.txInput[data-pane-id]')
  ) {
    event.preventDefault()
    const paneId = target.getAttribute('data-pane-id')
    if (paneId) {
      void sendPaneText(paneId)
    }
  }

  if (event.key === 'Enter' && target.matches('.terminalHiddenInput[data-pane-id]')) {
    event.preventDefault()
    const paneId = target.getAttribute('data-pane-id')
    const pane = paneId ? panes.get(paneId) : null
    const input = target as HTMLInputElement
    if (pane && input.value && pane.serialPort?.writable) {
      void writeSerialText(pane, input.value + pane.lineEnding, textEncoder)
        .then(() => {
          input.value = ''
        })
        .catch((error) => {
          pane.statusMessage = `send failed: ${(error as Error).message}`
          render()
        })
    }
  }
})

splitRootEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement

  const terminal = target.closest<HTMLElement>('.terminal[data-pane-id]')
  if (terminal) {
    const paneId = terminal.getAttribute('data-pane-id')
    if (paneId) {
      const hiddenInput = splitRootEl.querySelector<HTMLInputElement>(
        `.terminalHiddenInput[data-pane-id="${paneId}"]`,
      )
      if (hiddenInput) {
        hiddenInput.focus()
      }
    }
  }

  const actionButton = target.closest<HTMLButtonElement>('button[data-action][data-pane-id]')
  if (!actionButton) {
    return
  }
  const action = actionButton.getAttribute('data-action')
  const paneId = actionButton.getAttribute('data-pane-id')
  if (!action || !paneId) {
    return
  }
  if (action === 'quick-send') {
    const commandId = actionButton.getAttribute('data-command-id')
    if (commandId) {
      void sendQuickCommand(paneId, commandId)
    }
    return
  }
  if (action === 'timer-start') {
    const commandId = actionButton.getAttribute('data-timer-command-id')
    if (commandId) {
      startPaneTimer(paneId, commandId)
    }
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
  const paneId = menuPaneId
  hidePaneMenu()
  if (action === 'copy') {
    void copyPaneSelectionOrLog(paneId)
  } else if (action === 'split-vertical') {
    splitActivePane('vertical')
  } else if (action === 'split-horizontal') {
    splitActivePane('horizontal')
  } else if (action === 'close-pane') {
    void closeActivePane()
  }
})

quickCommandMenuEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const button = target.closest<HTMLButtonElement>('button[data-quick-menu-action]')
  if (!button || !quickCommandMenuPaneId || !quickCommandMenuCommandId) {
    return
  }

  const action = button.getAttribute('data-quick-menu-action')
  const paneId = quickCommandMenuPaneId
  const commandId = quickCommandMenuCommandId
  hideQuickCommandMenu()

  if (action === 'edit') {
    manageQuickCommand(paneId, commandId)
    return
  }

  if (action === 'delete') {
    const confirmed = window.confirm('Delete this quick command?')
    if (confirmed) {
      deleteQuickCommand(paneId, commandId)
    }
  }
})

timerCommandMenuEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const button = target.closest<HTMLButtonElement>('button[data-timer-menu-action]')
  if (!button || !timerCommandMenuPaneId || !timerCommandMenuCommandId) {
    return
  }

  const action = button.getAttribute('data-timer-menu-action')
  const paneId = timerCommandMenuPaneId
  const commandId = timerCommandMenuCommandId
  hideTimerCommandMenu()

  if (action === 'edit') {
    manageTimerCommand(paneId, commandId)
    return
  }

  if (action === 'delete') {
    const confirmed = window.confirm('Delete this timer command?')
    if (confirmed) {
      deleteTimerCommand(paneId, commandId)
    }
  }
})

document.addEventListener('click', (event) => {
  if (!paneMenuEl.contains(event.target as Node)) {
    hidePaneMenu()
  }
  if (!quickCommandMenuEl.contains(event.target as Node)) {
    hideQuickCommandMenu()
  }
  if (!timerCommandMenuEl.contains(event.target as Node)) {
    hideTimerCommandMenu()
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
    hideQuickCommandMenu()
    hideTimerCommandMenu()
    closeSettings()
    closeQuickCommandModal()
    closeTimerCommandModal()
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

closeQuickCommandBtn.addEventListener('click', () => {
  closeQuickCommandModal()
})

cancelQuickCommandBtn.addEventListener('click', () => {
  closeQuickCommandModal()
})

saveQuickCommandBtn.addEventListener('click', () => {
  saveQuickCommandFromModal()
})

deleteQuickCommandBtn.addEventListener('click', () => {
  deleteQuickCommandFromModal()
})

quickCommandNameEl.addEventListener('input', () => {
  validateQuickCommandForm()
})

quickCommandValueEl.addEventListener('input', () => {
  validateQuickCommandForm()
})

quickCommandFormatEl.addEventListener('change', () => {
  updateQuickCommandFormHelp()
  validateQuickCommandForm()
})

quickCommandAppendLineEndingEl.addEventListener('change', () => {
  updateQuickCommandPreview()
})

quickCommandPanelEl.addEventListener('click', (event) => {
  if (event.target === quickCommandPanelEl) {
    closeQuickCommandModal()
  }
})

quickCommandPanelEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    saveQuickCommandFromModal()
  }
})

closeTimerCommandBtn.addEventListener('click', () => {
  closeTimerCommandModal()
})

cancelTimerCommandBtn.addEventListener('click', () => {
  closeTimerCommandModal()
})

saveTimerCommandBtn.addEventListener('click', () => {
  saveTimerCommandFromModal()
})

deleteTimerCommandBtn.addEventListener('click', () => {
  deleteTimerCommandFromModal()
})

timerCommandNameEl.addEventListener('input', () => {
  validateTimerCommandForm()
})

timerCommandValueEl.addEventListener('input', () => {
  validateTimerCommandForm()
})

timerCommandFormatEl.addEventListener('change', () => {
  updateTimerCommandFormHelp()
  validateTimerCommandForm()
})

timerCommandAppendLineEndingEl.addEventListener('change', () => {
  updateTimerCommandPreview()
})

timerCommandIntervalEl.addEventListener('input', () => {
  validateTimerCommandForm()
})

timerCommandPanelEl.addEventListener('click', (event) => {
  if (event.target === timerCommandPanelEl) {
    closeTimerCommandModal()
  }
})

timerCommandPanelEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    saveTimerCommandFromModal()
  }
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

type FlashStatus =
  | 'idle'
  | 'connecting'
  | 'detecting'
  | 'flashing'
  | 'success'
  | 'error'

/**
 * Last-resort address map, used only for a zip carrying neither
 * `flasher_args.json` nor `partition-table.bin`. These offsets match gm_radar
 * builds from before the partition table moved otadata to 0xf000 and the app
 * to 0x20000, so a zip that falls through to them is flagged in the UI rather
 * than trusted.
 */
const legacyFlashLayout = new Map<number, string>([
  [0x0, 'bootloader.bin'],
  [0x8000, 'partition-table.bin'],
  [0xd000, 'ota_data_initial.bin'],
  [0x10000, 'mmwave_radar2_idf.bin'],
])

const flashRoleLabels: Record<FirmwareFileEntry['role'], string> = {
  bootloader: 'Bootloader',
  partitions: 'Partition table',
  ota_data: 'OTA data',
  app: 'Application',
  other: 'Data',
}

const flashSession: FlashSession = createFlashSession()

/** Resolved from the loaded zip; empty until one is loaded. */
let flashPlan: FirmwareFileEntry[] = []
/** Blocking layout problems. Non-empty disables the Flash button. */
let flashPlanErrors: string[] = []
let flashPlanParams: FirmwareFlashParams = {}
let flashPlanChip: string | null = null
let flashConsoleLines: string[] = []
let flashIsBusy = false
type AppTab = 'terminal' | 'flash' | 'config'
let activeAppTab: AppTab = 'terminal'

const refreshFlashControls = () => {
  const hasPort = flashSession.port !== null
  const hasLoader = flashSession.loader !== null
  const hasFiles = flashPlan.length > 0
  const planIsFlashable = hasFiles && flashPlanErrors.length === 0
  const anyTerminalConnected = Array.from(panes.values()).some((pane) => pane.isConnected)

  flashConnectBtn.disabled = flashIsBusy || hasPort || anyTerminalConnected
  flashDisconnectBtn.disabled = flashIsBusy || !hasPort
  flashDetectBtn.disabled = flashIsBusy || !hasPort
  flashStartBtn.disabled = flashIsBusy || !planIsFlashable || !hasLoader

  flashConnectBtn.textContent = anyTerminalConnected ? 'Disconnect terminal first' : 'Connect'
  if (!hasFiles) {
    flashStartBtn.textContent = '⚡ Flash (load a .zip)'
  } else if (flashPlanErrors.length > 0) {
    flashStartBtn.textContent = '⚡ Flash (layout check failed)'
  } else {
    flashStartBtn.textContent = `⚡ Flash ${flashPlan.length} file${flashPlan.length === 1 ? '' : 's'}`
  }

  flashBaudEl.disabled = flashIsBusy || hasLoader
  flashEraseAllEl.disabled = flashIsBusy
  flashCompressEl.disabled = flashIsBusy

  // While a zip is being parsed, ban Flash (slots may be transient) and
  // block re-entering the picker; the file <input> is also guarded by the
  // flashZipLoadInProgress flag in the change handler.
  if (flashZipLoadInProgress) {
    flashStartBtn.disabled = true
    flashStartBtn.textContent = 'Parsing zip…'
  }
  flashZipInputEl.disabled = flashIsBusy || flashZipLoadInProgress
  flashClearZipBtn.disabled = flashIsBusy || flashZipLoadInProgress || !hasFiles
}

const setFlashStatusMessage = (message: string) => {
  flashStatusEl.textContent = message
}

const appendFlashLog = (line: string) => {
  flashConsoleLines.push(line)
  if (flashConsoleLines.length > 2000) {
    flashConsoleLines = flashConsoleLines.slice(-1500)
  }
  flashConsoleOutputEl.textContent = flashConsoleLines.join('\n')
  flashConsoleOutputEl.scrollTop = flashConsoleOutputEl.scrollHeight
}

const writeFlashLogPartial = (data: string) => {
  if (flashConsoleLines.length === 0) {
    flashConsoleLines.push(data)
  } else {
    flashConsoleLines[flashConsoleLines.length - 1] += data
  }
  flashConsoleOutputEl.textContent = flashConsoleLines.join('\n')
  flashConsoleOutputEl.scrollTop = flashConsoleOutputEl.scrollHeight
}

const flashTerminal: FlashTerminal = {
  clean: () => {
    flashConsoleLines = []
    flashConsoleOutputEl.textContent = ''
  },
  writeLine: (data) => appendFlashLog(data),
  write: (data) => writeFlashLogPartial(data),
}

const showFlashChipInfo = (chip: FlashChipInfo | null) => {
  if (!chip) {
    flashChipInfoEl.classList.add('hidden')
    flashChipInfoEl.innerHTML = ''
    return
  }
  flashChipInfoEl.classList.remove('hidden')
  flashChipInfoEl.innerHTML = `
    <span class="flashChipDot" aria-hidden="true"></span>
    <div class="flashChipDetail">
      <p class="flashChipName">${escapeHtml(chip.chipName)}</p>
      ${chip.macAddress ? `<p class="flashChipMac">MAC: ${escapeHtml(chip.macAddress)}</p>` : ''}
    </div>
  `
}

const showFlashProgress = (
  show: boolean,
  options?: { percent?: number; message?: string },
) => {
  if (!show) {
    flashProgressEl.classList.add('hidden')
    return
  }
  flashProgressEl.classList.remove('hidden')
  const percent = Math.max(0, Math.min(100, Math.round(options?.percent ?? 0)))
  flashProgressFillEl.style.width = `${percent}%`
  flashProgressPercentEl.textContent = `${percent}%`
  if (typeof options?.message === 'string') {
    flashProgressMessageEl.textContent = options.message
  }
}

const setFlashStatus = (next: FlashStatus, message?: string) => {
  flashProgressEl.classList.toggle('isError', next === 'error')
  flashProgressEl.classList.toggle('isSuccess', next === 'success')
  if (message) {
    setFlashStatusMessage(message)
  }
}

const flashConnect = async () => {
  if (flashIsBusy) {
    return
  }
  const anyTerminalConnected = Array.from(panes.values()).some((pane) => pane.isConnected)
  if (anyTerminalConnected) {
    window.alert(
      'A pane is currently connected to a serial port. Disconnect all terminal sessions before flashing.',
    )
    return
  }
  try {
    flashIsBusy = true
    refreshFlashControls()
    setFlashStatus('connecting', 'Requesting serial port...')
    appendFlashLog('Requesting serial port...')
    const port = await requestFlashPort()
    flashSession.port = port
    appendFlashLog('Port selected.')
    setFlashStatus('idle', 'Port selected. Click "Detect chip" to begin.')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to select port'
    appendFlashLog(`Error: ${message}`)
    setFlashStatus('error', message)
  } finally {
    flashIsBusy = false
    refreshFlashControls()
  }
}

const flashDisconnect = async () => {
  if (flashIsBusy) {
    return
  }
  try {
    flashIsBusy = true
    refreshFlashControls()
    appendFlashLog('Disconnecting...')
    await disconnectFlashSession(flashSession)
    showFlashChipInfo(null)
    showFlashProgress(false)
    setFlashStatus('idle', 'Disconnected.')
    appendFlashLog('Disconnected.')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Disconnect failed'
    appendFlashLog(`Error: ${message}`)
    setFlashStatus('error', message)
  } finally {
    flashIsBusy = false
    refreshFlashControls()
  }
}

const flashDetect = async () => {
  if (flashIsBusy) {
    return
  }
  if (!flashSession.port) {
    setFlashStatus('error', 'Connect a port first.')
    return
  }
  try {
    flashIsBusy = true
    refreshFlashControls()
    setFlashStatus('detecting', 'Detecting chip...')
    showFlashProgress(true, { message: 'Detecting chip...', percent: 0 })
    const baudRate = Number(flashBaudEl.value) || defaultFlashBaud
    const chip = await flashDetectChip(flashSession, flashSession.port, baudRate, flashTerminal)
    showFlashChipInfo(chip)
    setFlashStatus('idle', `Chip detected: ${chip.chipName}`)
    showFlashProgress(false)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Detect failed'
    appendFlashLog(`Error: ${message}`)
    setFlashStatus('error', message)
    showFlashProgress(true, { message, percent: 0 })
  } finally {
    flashIsBusy = false
    refreshFlashControls()
  }
}

const flashStart = async () => {
  if (flashIsBusy) {
    return
  }
  if (flashPlan.length === 0) {
    setFlashStatus('error', 'Load a firmware .zip first.')
    return
  }
  if (flashPlanErrors.length > 0) {
    // The plan disagrees with the partition table it would flash; writing it
    // would leave the board unbootable, so refuse rather than warn.
    setFlashStatus('error', `Layout check failed: ${flashPlanErrors[0]}`)
    return
  }
  if (!flashSession.loader) {
    setFlashStatus('error', 'Run "Detect chip" before flashing.')
    return
  }

  // Guard against flashing e.g. an esp32s3 build onto an esp32. `chipFamily`
  // is esptool's bare CHIP_NAME; the verbose description is only a fallback.
  // If either side cannot be identified we log and continue — a guard that
  // blocks a good flash is worse than one that occasionally abstains, and the
  // partition-table checks already cover the real brick risk.
  const detectedChip = flashSession.chipInfo?.chipFamily || flashSession.chipInfo?.chipName || ''
  if (flashPlanChip && detectedChip) {
    const wanted = normalizeChipName(flashPlanChip)
    const found = normalizeChipName(detectedChip)
    if (wanted && found && wanted !== found) {
      const message = `Firmware targets ${wanted} but the connected board is ${found}.`
      appendFlashLog(`Error: ${message}`)
      setFlashStatus('error', message)
      return
    }
    if (!wanted || !found) {
      appendFlashLog(
        `Note: could not compare chip types (firmware "${flashPlanChip}" vs board "${detectedChip}").`,
      )
    }
  }

  const filesToFlash: FlashFile[] = flashPlan.map((entry, index) => ({
    id: `${entry.role}-${index}`,
    file: entry.file,
    address: entry.address,
  }))

  try {
    flashIsBusy = true
    refreshFlashControls()
    setFlashStatus('flashing', `Flashing ${filesToFlash.length} file(s)...`)
    showFlashProgress(true, { message: 'Starting flash...', percent: 0 })
    appendFlashLog('')
    appendFlashLog(
      `[Flash] Files: ${filesToFlash
        .map((item) => `${formatFlashAddress(item.address)} ${item.file.name}`)
        .join(', ')}`,
    )

    await flashFirmware(
      flashSession,
      {
        files: filesToFlash,
        eraseAll: flashEraseAllEl.checked,
        compress: flashCompressEl.checked,
        // Taken from the artifact (manifest, else the app image header) so a
        // rebuild with different flash settings still flashes correctly.
        flashMode: flashPlanParams.mode ?? 'keep',
        flashSize: flashPlanParams.size ?? 'keep',
        flashFreq: flashPlanParams.freq ?? 'keep',
        onProgress: (fileIndex, written, total) => {
          if (total <= 0) {
            return
          }
          const percent = Math.round((written / total) * 100)
          showFlashProgress(true, {
            percent,
            message: `Flashing file ${fileIndex + 1}/${filesToFlash.length}: ${percent}%`,
          })
        },
      },
      flashTerminal,
    )

    setFlashStatus('success', 'Flash complete! Port released.')
    showFlashProgress(true, { percent: 100, message: 'Flash complete!' })

    try {
      appendFlashLog('Releasing port after flash...')
      await disconnectFlashSession(flashSession, { hardReset: false })
      showFlashChipInfo(null)
      appendFlashLog('Port released. To flash another device, click Connect again.')
    } catch (cleanupError) {
      const message =
        cleanupError instanceof Error ? cleanupError.message : 'cleanup failed'
      appendFlashLog(`Cleanup warning: ${message}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Flash failed'
    appendFlashLog(`Error: ${message}`)
    setFlashStatus('error', message)
    showFlashProgress(true, { message, percent: 0 })
  } finally {
    flashIsBusy = false
    refreshFlashControls()
  }
}

const setFlashZipStatus = (
  html: string,
  state: 'idle' | 'ok' | 'partial' | 'error',
): void => {
  flashZipStatusEl.innerHTML = html
  flashZipStatusEl.classList.remove('isOk', 'isPartial', 'isError')
  if (state === 'ok') {
    flashZipStatusEl.classList.add('isOk')
  } else if (state === 'partial') {
    flashZipStatusEl.classList.add('isPartial')
  } else if (state === 'error') {
    flashZipStatusEl.classList.add('isError')
  }
}

let flashZipLoadInProgress = false

const ZIP_HINT_HTML =
  'Load a <code>.zip</code> from your CI build (e.g. <code>gm_radar-wifi-1.zip</code>). ' +
  'Addresses are read from the build\'s own flash map, so layout changes are picked up ' +
  'automatically.'

/**
 * Show the resolved plan as an address table. The whole point of the rework is
 * that addresses are no longer fixed, so the user needs to see the ones that
 * will actually be written.
 */
const renderFlashPlan = (): void => {
  if (flashPlan.length === 0 && flashPlanErrors.length === 0) {
    flashPlanEl.classList.add('hidden')
    flashPlanEl.innerHTML = ''
    return
  }
  flashPlanEl.classList.remove('hidden')

  const rows = flashPlan
    .map((entry) => {
      const target = entry.partitionLabel
        ? `<code>${escapeHtml(entry.partitionLabel)}</code>`
        : '<span class="flashPlanMuted">—</span>'
      return (
        '<tr>' +
        `<td><code>${escapeHtml(formatFlashAddress(entry.address))}</code></td>` +
        `<td>${escapeHtml(flashRoleLabels[entry.role])}</td>` +
        `<td>${escapeHtml(entry.name)}</td>` +
        `<td>${escapeHtml(formatFlashFileSize(entry.size))}</td>` +
        `<td>${target}</td>` +
        '</tr>'
      )
    })
    .join('')

  const errorHtml = flashPlanErrors.length
    ? '<ul class="flashPlanErrors">' +
      flashPlanErrors.map((item) => `<li>${escapeHtml(item)}</li>`).join('') +
      '</ul>'
    : ''

  flashPlanEl.innerHTML =
    (rows
      ? '<table class="flashPlanTable"><thead><tr>' +
        '<th>Address</th><th>Role</th><th>File</th><th>Size</th><th>Partition</th>' +
        '</tr></thead><tbody>' +
        rows +
        '</tbody></table>'
      : '') + errorHtml
}

const clearFlashPlan = (): void => {
  flashPlan = []
  flashPlanErrors = []
  flashPlanParams = {}
  flashPlanChip = null
  renderFlashPlan()
  refreshFlashControls()
}

const describeLayoutSource = (source: FirmwareZipSummary['layoutSource']): string => {
  if (source === 'manifest') {
    return 'flasher_args.json'
  }
  if (source === 'partition-table') {
    return 'partition-table.bin'
  }
  return 'built-in fallback addresses'
}

const loadFirmwareZip = async (zip: File): Promise<void> => {
  // Ignore concurrent picks while a previous parse is still running. The user
  // would otherwise be able to overwrite the in-flight load's result with a
  // racing one — and during the race the Flash button would still expose the
  // stale plan from a previous successful load.
  if (flashZipLoadInProgress) {
    appendFlashLog(
      `Ignored "${zip.name}" — another firmware zip is still being parsed.`,
    )
    return
  }
  flashZipLoadInProgress = true

  // Drop the previous plan immediately so Flash is disabled until the new
  // parse finishes; otherwise a click mid-parse would flash the old artifact.
  clearFlashPlan()

  appendFlashLog(`Loading firmware zip: ${zip.name} (${formatFlashFileSize(zip.size)})...`)
  setFlashZipStatus(`Parsing <code>${escapeHtml(zip.name)}</code>...`, 'idle')
  try {
    const summary = await extractFirmwareZip(zip, { defaultLayout: legacyFlashLayout })

    flashPlan = summary.entries
    flashPlanErrors = summary.errors
    flashPlanParams = summary.flashParams
    flashPlanChip = summary.flashParams.chip ?? summary.chipName ?? null
    renderFlashPlan()
    refreshFlashControls()

    const sourceLabel = describeLayoutSource(summary.layoutSource)
    appendFlashLog(
      `Zip loaded: ${summary.entries.length} file(s), addresses from ${sourceLabel}.`,
    )
    for (const entry of summary.entries) {
      appendFlashLog(
        `  ${formatFlashAddress(entry.address)}  ${entry.name} ` +
          `(${formatFlashFileSize(entry.size)})` +
          (entry.partitionLabel ? ` -> ${entry.partitionLabel}` : ''),
      )
    }
    if (summary.partitions) {
      appendFlashLog(
        `Partition table: ${summary.partitions
          .map((part) => `${part.label}@${formatFlashAddress(part.offset)}`)
          .join(' ')}`,
      )
    }
    const { mode, size, freq, chip } = summary.flashParams
    appendFlashLog(
      `Flash params: chip=${chip ?? '?'} mode=${mode ?? 'keep'} size=${size ?? 'keep'} freq=${freq ?? 'keep'}`,
    )
    for (const warning of summary.warnings) {
      appendFlashLog(`[zip] ${warning}`)
    }
    for (const error of summary.errors) {
      appendFlashLog(`[zip] BLOCKING: ${error}`)
    }
    if (summary.unassignedBins.length) {
      appendFlashLog(
        `Not flashed (no address in the build's flash map): ${summary.unassignedBins
          .map((entry) => entry.path)
          .join(', ')}`,
      )
    }

    if (summary.errors.length > 0) {
      setFlashZipStatus(
        `<strong>${escapeHtml(zip.name)}</strong> — layout check failed. ` +
          'Flashing is blocked because the addresses disagree with this build\'s partition table.',
        'error',
      )
    } else if (summary.entries.length === 0) {
      setFlashZipStatus(
        `<strong>${escapeHtml(zip.name)}</strong> contains no flashable firmware files.`,
        'error',
      )
    } else if (summary.layoutSource === 'defaults') {
      setFlashZipStatus(
        `<strong>${escapeHtml(zip.name)}</strong> has no <code>flasher_args.json</code> or ` +
          '<code>partition-table.bin</code>, so built-in fallback addresses were used. ' +
          'Check the addresses below before flashing.',
        'partial',
      )
    } else {
      const chipSuffix = summary.chipName ? ` for <code>${escapeHtml(summary.chipName)}</code>` : ''
      setFlashZipStatus(
        `<strong>${escapeHtml(zip.name)}</strong> loaded${chipSuffix} — ` +
          `${summary.entries.length} file(s), addresses from <code>${escapeHtml(sourceLabel)}</code>.`,
        'ok',
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to read zip'
    appendFlashLog(`Failed to load zip: ${message}`)
    setFlashZipStatus(
      `<strong>Failed to load ${escapeHtml(zip.name)}:</strong> ${escapeHtml(message)}`,
      'error',
    )
    clearFlashPlan()
  } finally {
    flashZipLoadInProgress = false
    refreshFlashControls()
  }
}

const setActiveAppTab = (tab: AppTab) => {
  if (activeAppTab === tab) {
    return
  }
  activeAppTab = tab
  const isTerminal = tab === 'terminal'
  const isFlash = tab === 'flash'
  const isConfig = tab === 'config'
  terminalTabBtn.classList.toggle('active', isTerminal)
  terminalTabBtn.setAttribute('aria-selected', String(isTerminal))
  flashTabBtn.classList.toggle('active', isFlash)
  flashTabBtn.setAttribute('aria-selected', String(isFlash))
  configTabBtn.classList.toggle('active', isConfig)
  configTabBtn.setAttribute('aria-selected', String(isConfig))
  terminalViewEl.classList.toggle('hidden', !isTerminal)
  terminalViewEl.setAttribute('aria-hidden', String(!isTerminal))
  flashViewEl.classList.toggle('hidden', !isFlash)
  flashViewEl.setAttribute('aria-hidden', String(!isFlash))
  configViewEl.classList.toggle('hidden', !isConfig)
  configViewEl.setAttribute('aria-hidden', String(!isConfig))
  if (isFlash) {
    refreshFlashControls()
  }
  if (isConfig) {
    refreshConfigControls()
  }
}

terminalTabBtn.addEventListener('click', () => {
  setActiveAppTab('terminal')
})

flashTabBtn.addEventListener('click', () => {
  setActiveAppTab('flash')
})

configTabBtn.addEventListener('click', () => {
  setActiveAppTab('config')
})

flashZipInputEl.addEventListener('change', () => {
  const file = flashZipInputEl.files?.[0]
  if (!file) {
    return
  }
  void loadFirmwareZip(file)
  // Reset so the same file can be re-picked after a Clear.
  flashZipInputEl.value = ''
})

flashClearZipBtn.addEventListener('click', () => {
  if (flashIsBusy) {
    return
  }
  clearFlashPlan()
  setFlashZipStatus(ZIP_HINT_HTML, 'idle')
  appendFlashLog('Cleared firmware plan.')
})

flashConnectBtn.addEventListener('click', () => {
  void flashConnect()
})

flashDisconnectBtn.addEventListener('click', () => {
  void flashDisconnect()
})

flashDetectBtn.addEventListener('click', () => {
  void flashDetect()
})

flashStartBtn.addEventListener('click', () => {
  void flashStart()
})

flashCopyLogBtn.addEventListener('click', () => {
  const text = flashConsoleLines.join('\n')
  if (!text) {
    return
  }
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text)
  }
})

flashClearLogBtn.addEventListener('click', () => {
  flashConsoleLines = []
  flashConsoleOutputEl.textContent = ''
})

// ============================================================================
// Config tab: apply AT-mode JSON configuration over Web Serial
// ============================================================================

type ConfigSession = {
  port: SerialPort | null
  isApplying: boolean
  shouldCancel: boolean
}

const configSession: ConfigSession = {
  port: null,
  isApplying: false,
  shouldCancel: false,
}

let configConsoleLines: string[] = []
let configJsonValid = false
let configControlsReady = false

const populateConfigBaudSelect = () => {
  configBaudSelect.innerHTML = ''
  for (const rate of flashBaudRates) {
    const option = document.createElement('option')
    option.value = String(rate)
    option.textContent = rate.toLocaleString()
    // AT mode uses 115200 by default per configure_device.py.
    if (rate === 115200) {
      option.selected = true
    }
    configBaudSelect.appendChild(option)
  }
}

const appendConfigLog = (line: string) => {
  configConsoleLines.push(line)
  if (configConsoleLines.length > 4000) {
    configConsoleLines = configConsoleLines.slice(-3000)
  }
  configConsoleOutputEl.textContent = configConsoleLines.join('\n')
  configConsoleOutputEl.scrollTop = configConsoleOutputEl.scrollHeight
}

const writeConfigLogPartial = (chunk: string) => {
  if (configConsoleLines.length === 0) {
    configConsoleLines.push('')
  }
  const pieces = chunk.split(/\r?\n/)
  configConsoleLines[configConsoleLines.length - 1] += pieces[0]
  for (let i = 1; i < pieces.length; i += 1) {
    configConsoleLines.push(pieces[i])
  }
  if (configConsoleLines.length > 4000) {
    configConsoleLines = configConsoleLines.slice(-3000)
  }
  configConsoleOutputEl.textContent = configConsoleLines.join('\n')
  configConsoleOutputEl.scrollTop = configConsoleOutputEl.scrollHeight
}

const setConfigStatus = (
  state: 'idle' | 'busy' | 'success' | 'error',
  message?: string,
): void => {
  configStatusEl.classList.remove('hidden')
  configStatusEl.classList.toggle('isSuccess', state === 'success')
  configStatusEl.classList.toggle('isError', state === 'error')
  configStatusEl.classList.toggle('isBusy', state === 'busy')
  configStatusMessageEl.textContent = message ?? (state === 'idle' ? 'Idle' : state)
}

const setConfigProgressPercent = (percent: number): void => {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  configStatusFillEl.style.width = `${clamped}%`
  configStatusPercentEl.textContent = `${clamped}%`
}

const updateConfigProgress = (progress: ApplyConfigProgress): void => {
  const percent = progress.total > 0 ? (progress.step / progress.total) * 100 : 0
  setConfigProgressPercent(percent)
  const phaseLabel =
    progress.phase === 'boot'
      ? 'Waiting for AT mode'
      : progress.phase === 'write'
        ? `Writing ${progress.label}`
        : progress.phase === 'finalize'
          ? progress.label
          : 'Done'
  configStatusMessageEl.textContent = `${phaseLabel} (${progress.step}/${progress.total})`
}

const showConfigPortInfo = (text: string | null): void => {
  if (!text) {
    configPortInfoEl.classList.add('hidden')
    configPortInfoEl.textContent = ''
    return
  }
  configPortInfoEl.classList.remove('hidden')
  configPortInfoEl.textContent = text
}

const validateConfigJson = (): boolean => {
  const text = configJsonEditor.value.trim()
  if (!text) {
    configJsonStatusEl.textContent = ''
    configJsonStatusEl.classList.remove('isError', 'isOk')
    configJsonValid = false
    return false
  }
  const result = parseJsonConfig(text)
  if (!result.ok) {
    configJsonStatusEl.textContent = `Invalid JSON: ${result.error}`
    configJsonStatusEl.classList.add('isError')
    configJsonStatusEl.classList.remove('isOk')
    configJsonValid = false
    return false
  }
  const keyCount = Object.keys(result.value).length
  configJsonStatusEl.textContent = `Valid JSON • ${keyCount} key${keyCount === 1 ? '' : 's'}`
  configJsonStatusEl.classList.remove('isError')
  configJsonStatusEl.classList.add('isOk')
  configJsonValid = true
  return true
}

const refreshConfigControls = (): void => {
  const hasPort = configSession.port !== null
  const isBusy = configSession.isApplying
  const anyTerminalConnected = Array.from(panes.values()).some((pane) => pane.isConnected)

  configConnectBtn.disabled = isBusy || hasPort || anyTerminalConnected
  configConnectBtn.textContent = anyTerminalConnected
    ? 'Disconnect terminal first'
    : hasPort
      ? 'Connected'
      : 'Connect'
  configDisconnectBtn.disabled = isBusy || !hasPort
  configApplyBtn.disabled = isBusy || !hasPort || !configJsonValid
  configCancelBtn.hidden = !isBusy
  configCancelBtn.disabled = !isBusy || configSession.shouldCancel

  configBaudSelect.disabled = isBusy || hasPort
  configResetSelect.disabled = isBusy
  configEndSelect.disabled = isBusy
  configFileInput.disabled = isBusy
  configClearJsonBtn.disabled = isBusy
  configFilenameInput.disabled = isBusy
  configJsonEditor.disabled = isBusy
}

const configConnect = async (): Promise<void> => {
  if (configSession.port !== null) {
    return
  }
  if (!navigator.serial) {
    appendConfigLog('Web Serial unavailable in this browser.')
    setConfigStatus('error', 'Web Serial unavailable')
    return
  }
  try {
    setConfigStatus('busy', 'Requesting serial port...')
    appendConfigLog('Requesting serial port...')
    const port = await requestConfigPort()
    configSession.port = port
    const info = port.getInfo?.() ?? {}
    const vid =
      typeof info.usbVendorId === 'number'
        ? `VID 0x${info.usbVendorId.toString(16).padStart(4, '0')}`
        : null
    const pid =
      typeof info.usbProductId === 'number'
        ? `PID 0x${info.usbProductId.toString(16).padStart(4, '0')}`
        : null
    const portLabel = [vid, pid].filter(Boolean).join(' · ') || 'Serial port'
    showConfigPortInfo(`Port ready · ${portLabel}`)
    appendConfigLog(`Port acquired (${portLabel}). Ready to apply configuration.`)
    setConfigStatus('idle', 'Port ready')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to request port'
    if (/no port selected/i.test(message)) {
      appendConfigLog('Port selection cancelled by user.')
      setConfigStatus('idle', 'Cancelled')
    } else {
      appendConfigLog(`Connect failed: ${message}`)
      setConfigStatus('error', message)
    }
  } finally {
    refreshConfigControls()
  }
}

const configDisconnect = async (): Promise<void> => {
  if (configSession.port === null) {
    return
  }
  if (configSession.isApplying) {
    appendConfigLog('Cannot disconnect while Apply is in progress. Use Cancel first.')
    return
  }
  const port = configSession.port
  configSession.port = null
  try {
    await closeConfigPort(port)
    appendConfigLog('Port released.')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'close failed'
    appendConfigLog(`Disconnect warning: ${message}`)
  }
  showConfigPortInfo(null)
  setConfigStatus('idle')
  refreshConfigControls()
}

const configApply = async (): Promise<void> => {
  if (!configSession.port || configSession.isApplying) {
    return
  }
  if (!validateConfigJson()) {
    appendConfigLog('Cannot apply: JSON is invalid or empty.')
    return
  }
  const parsed = parseJsonConfig(configJsonEditor.value)
  if (!parsed.ok) {
    appendConfigLog(`Cannot apply: ${parsed.error}`)
    return
  }

  const cfgFilename =
    configFilenameInput.value.trim() ||
    (parsed.value.CFGFILE && typeof parsed.value.CFGFILE === 'string'
      ? parsed.value.CFGFILE
      : 'config.json')

  const resetMode = configResetSelect.value as ResetMode
  const endCommand = configEndSelect.value as EndCommand
  const baudRate = Number(configBaudSelect.value) || 115200

  configSession.isApplying = true
  configSession.shouldCancel = false
  refreshConfigControls()
  setConfigStatus('busy', 'Waiting for AT mode...')
  setConfigProgressPercent(0)

  appendConfigLog(`${'='.repeat(60)}`)
  appendConfigLog('ESP32 AT Config Tool')
  appendConfigLog(`  Config file : ${cfgFilename}`)
  appendConfigLog(`  Baud rate   : ${baudRate}`)
  appendConfigLog(`  Reset mode  : ${resetMode}`)
  appendConfigLog(`  End command : AT+${endCommand === 'cont' ? 'CONT' : 'RST='}`)
  appendConfigLog(`${'='.repeat(60)}`)

  const logger: ConfigLogger = {
    onDeviceData: writeConfigLogPartial,
    onStatus: (line) => appendConfigLog(line),
    onWarn: (line) => appendConfigLog(`[WARN] ${line}`),
    onError: (line) => appendConfigLog(`[ERROR] ${line}`),
  }

  try {
    const ok = await runApplyConfig({
      port: configSession.port,
      config: parsed.value,
      configFilename: cfgFilename,
      resetMode,
      endCommand,
      baudRate,
      logger,
      shouldCancel: () => configSession.shouldCancel,
      onProgress: updateConfigProgress,
    })
    if (ok) {
      setConfigProgressPercent(100)
      setConfigStatus('success', 'Configuration applied successfully')
    } else {
      // applyConfig only reports success when every key was confirmed by the
      // device's post-write acknowledgement — see the console for which failed.
      setConfigStatus(
        'error',
        'Apply did not complete cleanly — some keys were not confirmed by the device. See console.',
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'apply failed'
    appendConfigLog(`Apply error: ${message}`)
    setConfigStatus('error', message)
  } finally {
    configSession.isApplying = false
    configSession.shouldCancel = false
    refreshConfigControls()
  }
}

configBaudSelect.addEventListener('change', () => {
  refreshConfigControls()
})

configResetSelect.addEventListener('change', () => {
  refreshConfigControls()
})

configEndSelect.addEventListener('change', () => {
  refreshConfigControls()
})

configFileInput.addEventListener('change', () => {
  const file = configFileInput.files?.[0]
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const result = reader.result
    if (typeof result !== 'string') {
      return
    }
    configJsonEditor.value = result
    if (!configFilenameInput.value.trim()) {
      configFilenameInput.value = file.name
    }
    validateConfigJson()
    refreshConfigControls()
    appendConfigLog(`Loaded JSON from "${file.name}" (${file.size} bytes).`)
  }
  reader.onerror = () => {
    appendConfigLog(`Failed to read "${file.name}": ${reader.error?.message ?? 'unknown error'}`)
  }
  reader.readAsText(file)
  // Reset so the same file can be re-picked after a Clear.
  configFileInput.value = ''
})

configClearJsonBtn.addEventListener('click', () => {
  configJsonEditor.value = ''
  configFilenameInput.value = ''
  validateConfigJson()
  refreshConfigControls()
})

configJsonEditor.addEventListener('input', () => {
  validateConfigJson()
  refreshConfigControls()
})

configFilenameInput.addEventListener('input', () => {
  refreshConfigControls()
})

configConnectBtn.addEventListener('click', () => {
  void configConnect()
})

configDisconnectBtn.addEventListener('click', () => {
  void configDisconnect()
})

configApplyBtn.addEventListener('click', () => {
  void configApply()
})

configCancelBtn.addEventListener('click', () => {
  if (!configSession.isApplying) {
    return
  }
  configSession.shouldCancel = true
  appendConfigLog('Cancellation requested...')
  refreshConfigControls()
})

configCopyLogBtn.addEventListener('click', () => {
  const text = configConsoleLines.join('\n')
  if (!text) {
    return
  }
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text)
  }
})

configClearLogBtn.addEventListener('click', () => {
  configConsoleLines = []
  configConsoleOutputEl.textContent = ''
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

  flashControlsReady = true
  refreshFlashControls()
  showFlashChipInfo(null)
  showFlashProgress(false)
  setFlashStatus('idle')

  populateConfigBaudSelect()
  validateConfigJson()
  showConfigPortInfo(null)
  setConfigStatus('idle')
  configControlsReady = true
  refreshConfigControls()

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
    if (pane.activeTimerHandle !== null) {
      window.clearInterval(pane.activeTimerHandle)
    }
    if (pane.shareStatus === 'creating' || pane.shareStatus === 'sharing') {
      clearPaneShareSocket(pane)
    }
    releaseConnectionLock(pane.connectedUartName)
  }
  void disconnectFlashSession(flashSession)
  if (configSession.port !== null) {
    void closeConfigPort(configSession.port)
  }
})

initialize()

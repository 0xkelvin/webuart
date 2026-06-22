type Parity = 'none' | 'even' | 'odd'
type FlowControl = 'none' | 'hardware'

declare global {
  interface Navigator {
    serial?: {
      requestPort: () => Promise<SerialPort>
    }
  }

  interface SerialPortInfo {
    usbVendorId?: number
    usbProductId?: number
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
    setSignals?: (signals: {
      dataTerminalReady?: boolean
      requestToSend?: boolean
      break?: boolean
    }) => Promise<void>
    getInfo?: () => SerialPortInfo
    readable: ReadableStream<Uint8Array> | null
    writable: WritableStream<Uint8Array> | null
  }

  interface Window {
    __ONLINE_UART_SHARE_API_BASE__?: string
    __ONLINE_UART_SHARE_WS_BASE__?: string
  }
}

export {}

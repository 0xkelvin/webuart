type SerialSession = {
  serialPort: SerialPort | null
  reader: ReadableStreamDefaultReader<Uint8Array> | null
  isReading: boolean
}

type ReadLoopHandlers = {
  onChunk: (chunk: Uint8Array) => void
  onError: (errorMessage: string) => void
}

type SerialConnectOptions = {
  serial: NonNullable<Navigator['serial']>
  settings: {
    baudRate: number
    dataBits?: 7 | 8
    stopBits?: 1 | 2
    parity?: 'none' | 'even' | 'odd'
    flowControl?: 'none' | 'hardware'
    bufferSize?: number
  }
}

export const connectSerialSession = async (
  session: SerialSession,
  options: SerialConnectOptions,
) => {
  const port = await options.serial.requestPort()
  await port.open({
    baudRate: options.settings.baudRate,
    dataBits: options.settings.dataBits,
    stopBits: options.settings.stopBits,
    parity: options.settings.parity,
    flowControl: options.settings.flowControl,
    bufferSize: options.settings.bufferSize,
  })

  session.serialPort = port
  session.isReading = false
  session.reader = null

  return port
}

export const disconnectSerialSession = async (session: SerialSession) => {
  session.isReading = false

  try {
    await session.reader?.cancel()
  } catch {
    // Ignore reader cancel errors while disconnecting.
  }

  try {
    await session.serialPort?.close()
  } catch {
    // Ignore close errors while disconnecting.
  }

  session.reader = null
  session.serialPort = null
}

export const runSerialReadLoop = async (
  session: SerialSession,
  handlers: ReadLoopHandlers,
) => {
  if (!session.serialPort?.readable) {
    return
  }

  session.isReading = true

  try {
    while (session.isReading && session.serialPort?.readable) {
      const reader = session.serialPort.readable.getReader()
      session.reader = reader

      try {
        while (session.isReading) {
          const { value, done } = await reader.read()
          if (done) {
            break
          }
          if (value) {
            handlers.onChunk(value)
          }
        }
      } finally {
        reader.releaseLock()
        if (session.reader === reader) {
          session.reader = null
        }
      }
    }
  } catch (error) {
    handlers.onError(error instanceof Error ? error.message : 'unknown read error')
  } finally {
    session.isReading = false
  }
}

export const writeSerialBytes = async (session: SerialSession, bytes: Uint8Array) => {
  if (!session.serialPort?.writable) {
    throw new Error('serial port is not writable')
  }

  const writer = session.serialPort.writable.getWriter()
  try {
    await writer.write(bytes)
  } finally {
    writer.releaseLock()
  }
}

export const writeSerialText = async (
  session: SerialSession,
  payload: string,
  encoder: TextEncoder,
) => {
  await writeSerialBytes(session, encoder.encode(payload))
}

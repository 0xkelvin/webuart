type RuntimeWindow = Window & {
  __ONLINE_UART_SHARE_API_BASE__?: string
  __ONLINE_UART_SHARE_WS_BASE__?: string
}

const isLocalHostName = (hostname: string) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'

const getShareConfigMeta = (name: string) => {
  const content = document
    .querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
    ?.getAttribute('content')
    ?.trim()
  return content && content.length > 0 ? content : null
}

export const getShareApiBase = () => {
  const runtimeWindow = window as RuntimeWindow

  if (runtimeWindow.__ONLINE_UART_SHARE_API_BASE__) {
    return runtimeWindow.__ONLINE_UART_SHARE_API_BASE__
  }

  const metaApiBase = getShareConfigMeta('online-uart-share-api-base')
  if (metaApiBase) {
    return metaApiBase
  }

  return isLocalHostName(window.location.hostname)
    ? 'http://localhost:8787'
    : window.location.origin
}

export const getShareWsBase = () => {
  const runtimeWindow = window as RuntimeWindow

  if (runtimeWindow.__ONLINE_UART_SHARE_WS_BASE__) {
    return runtimeWindow.__ONLINE_UART_SHARE_WS_BASE__
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

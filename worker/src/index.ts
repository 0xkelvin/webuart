import { SessionRoom } from './session'

export { SessionRoom }

export interface Env {
  SESSION_ROOM: DurableObjectNamespace
  ALLOWED_ORIGINS?: string
}

const defaultAllowedOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

const getAllowedOrigins = (env: Env) => {
  const configured = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : []
  const all = [...configured, ...defaultAllowedOrigins]
  return Array.from(new Set(all))
}

const isOriginAllowed = (request: Request, env: Env) => {
  const origin = request.headers.get('Origin')
  if (!origin) {
    return true
  }
  if (origin === new URL(request.url).origin) {
    return true
  }
  return getAllowedOrigins(env).includes(origin)
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin')
  const allowedOrigins = getAllowedOrigins(env)
  const accessControlAllowOrigin =
    origin && (allowedOrigins.includes(origin) || origin === new URL(request.url).origin)
      ? origin
      : allowedOrigins[0] ?? defaultAllowedOrigins[0]

  return {
    'Access-Control-Allow-Origin': accessControlAllowOrigin,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  }
}

function jsonResponse(data: unknown, status: number, request: Request, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request, env),
    },
  })
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 })
    return true
  }
  entry.count += 1
  return entry.count <= 10
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (!isOriginAllowed(request, env)) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, request, env)
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      })
    }

    if (request.method === 'POST' && path === '/api/sessions') {
      const ip =
        request.headers.get('cf-connecting-ip') ||
        request.headers.get('x-forwarded-for') ||
        '127.0.0.1'
      if (!checkRateLimit(ip)) {
        return jsonResponse({ error: 'Rate limit exceeded' }, 429, request, env)
      }

      const sessionId = crypto.randomUUID()
      const hostToken = crypto.randomUUID()

      const doId = env.SESSION_ROOM.idFromName(sessionId)
      const stub = env.SESSION_ROOM.get(doId)
      await stub.fetch(
        new Request('https://internal/init', {
          method: 'POST',
          body: JSON.stringify({ hostToken }),
        }),
      )

      return jsonResponse({ sessionId, hostToken }, 201, request, env)
    }

    const wsMatch = path.match(/^\/api\/sessions\/([^/]+)\/ws$/)
    if (request.method === 'GET' && wsMatch) {
      const sessionId = wsMatch[1]
      const role = url.searchParams.get('role')

      if (role !== 'host' && role !== 'viewer') {
        return jsonResponse(
          { error: 'Invalid role', code: 'INVALID_ROLE' },
          400,
          request,
          env,
        )
      }

      const doId = env.SESSION_ROOM.idFromName(sessionId)
      const stub = env.SESSION_ROOM.get(doId)
      return stub.fetch(request)
    }

    return jsonResponse({ error: 'Not found' }, 404, request, env)
  },
}

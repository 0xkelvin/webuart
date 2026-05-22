var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/session.ts
var MAX_BUFFER_BYTES = 256 * 1024;
var MAX_SESSION_BYTES = 512 * 1024;
var MAX_SESSION_DURATION_MS = 30 * 60 * 1e3;
var INACTIVITY_TIMEOUT_MS = 60 * 1e3;
var ALARM_INTERVAL_MS = 30 * 1e3;
var SessionRoom = class {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  static {
    __name(this, "SessionRoom");
  }
  sessionState = null;
  async getSessionState() {
    if (this.sessionState) {
      return this.sessionState;
    }
    this.sessionState = await this.state.storage.get("session") ?? null;
    return this.sessionState;
  }
  async saveSessionState() {
    if (!this.sessionState) {
      return;
    }
    await this.state.storage.put("session", this.sessionState);
  }
  getHostWs() {
    const sockets = this.state.getWebSockets("host");
    return sockets.length > 0 ? sockets[0] : null;
  }
  getViewerWs() {
    const sockets = this.state.getWebSockets("viewer");
    return sockets.length > 0 ? sockets[0] : null;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/init" && request.method === "POST") {
      const body = await request.json();
      this.sessionState = {
        hostToken: body.hostToken,
        hostAuthenticated: false,
        buffer: [],
        bufferBytes: 0,
        totalBytes: 0,
        lastHostMessage: Date.now(),
        createdAt: Date.now()
      };
      await this.saveSessionState();
      this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      return new Response("ok");
    }
    const role = url.searchParams.get("role");
    if (role === "host") {
      return this.handleHostUpgrade();
    }
    if (role === "viewer") {
      return this.handleViewerUpgrade();
    }
    return new Response("Bad request", { status: 400 });
  }
  async handleHostUpgrade() {
    const session = await this.getSessionState();
    if (!session) {
      return this.wsError("SESSION_NOT_FOUND", "Session not initialized");
    }
    if (this.getHostWs()) {
      return this.wsError("HOST_EXISTS", "Host already connected");
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], ["host"]);
    session.hostAuthenticated = false;
    session.lastHostMessage = Date.now();
    await this.saveSessionState();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async handleViewerUpgrade() {
    const session = await this.getSessionState();
    if (!session) {
      return this.wsError("SESSION_NOT_FOUND", "Session not found");
    }
    const oldViewer = this.getViewerWs();
    if (oldViewer) {
      this.sendTo(oldViewer, { type: "session_closed" });
      try {
        oldViewer.close(1e3, "Replaced by new viewer");
      } catch {
      }
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], ["viewer"]);
    const history = session.buffer.join("");
    this.sendTo(pair[1], { type: "history", payload: history });
    const hostWs = this.getHostWs();
    if (hostWs) {
      this.sendTo(hostWs, { type: "viewer_connected" });
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws, message) {
    if (typeof message !== "string") {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    const tags = this.state.getTags(ws);
    const isHost = tags.includes("host");
    if (!isHost) {
      return;
    }
    const session = await this.getSessionState();
    if (!session) {
      return;
    }
    if (!session.hostAuthenticated) {
      if (parsed.type === "auth" && parsed.token) {
        if (parsed.token !== session.hostToken) {
          this.sendTo(ws, { type: "error", code: "INVALID_TOKEN", message: "Invalid host token" });
          try {
            ws.close(1008, "Invalid token");
          } catch {
          }
          return;
        }
        const newToken = crypto.randomUUID();
        session.hostToken = newToken;
        session.hostAuthenticated = true;
        session.lastHostMessage = Date.now();
        await this.saveSessionState();
        this.sendTo(ws, { type: "auth_ok", newToken });
      }
      return;
    }
    session.lastHostMessage = Date.now();
    if (parsed.type === "ping") {
      this.sendTo(ws, { type: "pong" });
      await this.saveSessionState();
      return;
    }
    if (parsed.type !== "data" || !parsed.payload) {
      return;
    }
    const payloadBytes = parsed.payload.length;
    session.totalBytes += payloadBytes;
    if (session.totalBytes > MAX_SESSION_BYTES) {
      this.sendTo(ws, {
        type: "error",
        code: "LIMIT_REACHED",
        message: "Session data cap exceeded"
      });
      await this.closeSession();
      return;
    }
    session.buffer.push(parsed.payload);
    session.bufferBytes += payloadBytes;
    while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 0) {
      const removed = session.buffer.shift();
      session.bufferBytes -= removed.length;
    }
    await this.saveSessionState();
    const viewerWs = this.getViewerWs();
    if (viewerWs) {
      this.sendTo(viewerWs, { type: "data", payload: parsed.payload });
    }
  }
  async webSocketClose(ws) {
    const tags = this.state.getTags(ws);
    if (tags.includes("host")) {
      const viewerWs = this.getViewerWs();
      if (viewerWs) {
        this.sendTo(viewerWs, { type: "session_closed" });
        try {
          viewerWs.close(1e3, "Host disconnected");
        } catch {
        }
      }
      await this.state.storage.deleteAll();
      this.sessionState = null;
      return;
    }
    if (tags.includes("viewer")) {
      const hostWs = this.getHostWs();
      if (hostWs) {
        this.sendTo(hostWs, { type: "viewer_disconnected" });
      }
    }
  }
  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
  async alarm() {
    const session = await this.getSessionState();
    if (!session) {
      return;
    }
    const now = Date.now();
    if (now - session.lastHostMessage > INACTIVITY_TIMEOUT_MS) {
      await this.closeSession();
      return;
    }
    if (now - session.createdAt > MAX_SESSION_DURATION_MS) {
      const hostWs = this.getHostWs();
      const viewerWs = this.getViewerWs();
      const message = {
        type: "error",
        code: "LIMIT_REACHED",
        message: "Maximum session duration exceeded"
      };
      if (hostWs) {
        this.sendTo(hostWs, message);
      }
      if (viewerWs) {
        this.sendTo(viewerWs, message);
      }
      await this.closeSession();
      return;
    }
    if (this.getHostWs()) {
      this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
    }
  }
  async closeSession() {
    const hostWs = this.getHostWs();
    const viewerWs = this.getViewerWs();
    if (hostWs) {
      this.sendTo(hostWs, { type: "session_closed" });
      try {
        hostWs.close(1e3, "Session closed");
      } catch {
      }
    }
    if (viewerWs) {
      this.sendTo(viewerWs, { type: "session_closed" });
      try {
        viewerWs.close(1e3, "Session closed");
      } catch {
      }
    }
    await this.state.storage.deleteAll();
    this.sessionState = null;
  }
  sendTo(ws, message) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
    }
  }
  wsError(code, message) {
    return new Response(JSON.stringify({ error: message, code }), {
      status: 400,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
};

// src/index.ts
var defaultAllowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];
var getAllowedOrigins = /* @__PURE__ */ __name((env) => {
  const configured = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean) : [];
  const all = [...configured, ...defaultAllowedOrigins];
  return Array.from(new Set(all));
}, "getAllowedOrigins");
var isOriginAllowed = /* @__PURE__ */ __name((request, env) => {
  const origin = request.headers.get("Origin");
  if (!origin) {
    return true;
  }
  if (origin === new URL(request.url).origin) {
    return true;
  }
  return getAllowedOrigins(env).includes(origin);
}, "isOriginAllowed");
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowedOrigins = getAllowedOrigins(env);
  const accessControlAllowOrigin = origin && (allowedOrigins.includes(origin) || origin === new URL(request.url).origin) ? origin : allowedOrigins[0] ?? defaultAllowedOrigins[0];
  return {
    "Access-Control-Allow-Origin": accessControlAllowOrigin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin"
  };
}
__name(corsHeaders, "corsHeaders");
function jsonResponse(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request, env)
    }
  });
}
__name(jsonResponse, "jsonResponse");
var rateLimitMap = /* @__PURE__ */ new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 6e4 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 10;
}
__name(checkRateLimit, "checkRateLimit");
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!isOriginAllowed(request, env)) {
      return jsonResponse({ error: "Origin not allowed" }, 403, request, env);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env)
      });
    }
    if (request.method === "POST" && path === "/api/sessions") {
      const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "127.0.0.1";
      if (!checkRateLimit(ip)) {
        return jsonResponse({ error: "Rate limit exceeded" }, 429, request, env);
      }
      const sessionId = crypto.randomUUID();
      const hostToken = crypto.randomUUID();
      const doId = env.SESSION_ROOM.idFromName(sessionId);
      const stub = env.SESSION_ROOM.get(doId);
      await stub.fetch(
        new Request("https://internal/init", {
          method: "POST",
          body: JSON.stringify({ hostToken })
        })
      );
      return jsonResponse({ sessionId, hostToken }, 201, request, env);
    }
    const wsMatch = path.match(/^\/api\/sessions\/([^/]+)\/ws$/);
    if (request.method === "GET" && wsMatch) {
      const sessionId = wsMatch[1];
      const role = url.searchParams.get("role");
      if (role !== "host" && role !== "viewer") {
        return jsonResponse(
          { error: "Invalid role", code: "INVALID_ROLE" },
          400,
          request,
          env
        );
      }
      const doId = env.SESSION_ROOM.idFromName(sessionId);
      const stub = env.SESSION_ROOM.get(doId);
      return stub.fetch(request);
    }
    return jsonResponse({ error: "Not found" }, 404, request, env);
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-FDzeOv/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-FDzeOv/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  SessionRoom,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map

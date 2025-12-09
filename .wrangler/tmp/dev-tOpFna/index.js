var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-zhyLSL/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// index.js
import { DurableObject } from "cloudflare:workers";
var SessionsStore = class extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.sessions = /* @__PURE__ */ new Map();
    this.initialized = false;
  }
  // 初始化方法，加载会话
  async initialize() {
    if (!this.initialized) {
      await this.state.blockConcurrencyWhile(async () => {
        const stored = await this.state.storage.get("sessions");
        if (stored) {
          this.sessions = new Map(JSON.parse(stored));
        }
        this.initialized = true;
      });
    }
  }
  // 保存会话到持久化存储
  async saveSessions() {
    await this.state.storage.put("sessions", JSON.stringify(Array.from(this.sessions.entries())));
  }
  // 创建新会话
  async createSession() {
    await this.initialize();
    const pickupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const session = {
      pickupCode,
      fileInfo: null,
      chunks: [],
      isTransferring: false,
      startTime: Date.now()
    };
    this.sessions.set(pickupCode, session);
    await this.saveSessions();
    return pickupCode;
  }
  // 加入会话
  async joinSession(pickupCode) {
    await this.initialize();
    const session = this.sessions.get(pickupCode);
    if (session) {
      return session;
    }
    return null;
  }
  // 获取会话
  async getSession(pickupCode) {
    await this.initialize();
    return this.sessions.get(pickupCode);
  }
  // 更新文件信息
  async updateFileInfo(pickupCode, fileInfo) {
    await this.initialize();
    const session = this.sessions.get(pickupCode);
    if (session) {
      session.fileInfo = fileInfo;
      await this.saveSessions();
      return true;
    }
    return false;
  }
  // 添加文件块
  async addFileChunk(pickupCode, chunkIndex, chunk, isLast) {
    await this.initialize();
    const session = this.sessions.get(pickupCode);
    if (session) {
      if (!session.chunks) {
        session.chunks = [];
      }
      session.chunks[chunkIndex] = chunk;
      if (isLast) {
        session.isTransferring = false;
        session.isComplete = true;
      }
      await this.saveSessions();
      return true;
    }
    return false;
  }
  // 更新传输状态
  async updateTransferStatus(pickupCode, isTransferring) {
    await this.initialize();
    const session = this.sessions.get(pickupCode);
    if (session) {
      session.isTransferring = isTransferring;
      await this.saveSessions();
      return true;
    }
    return false;
  }
  // 清理会话
  async cleanupSession(pickupCode) {
    await this.initialize();
    this.sessions.delete(pickupCode);
    await this.saveSessions();
  }
};
__name(SessionsStore, "SessionsStore");
async function handleStaticFile(request, env) {
  try {
    return await env.ASSETS.fetch(request);
  } catch (error) {
    console.error("Static file error:", error);
    if (new URL(request.url).pathname === "/") {
      try {
        const indexResponse = await env.ASSETS.fetch(new Request(
          new URL("/index.html", request.url),
          { method: "GET" }
        ));
        return indexResponse;
      } catch (e) {
        console.error("Failed to fetch index.html:", e);
      }
    }
    return new Response("404 Not Found", { status: 404 });
  }
}
__name(handleStaticFile, "handleStaticFile");
function handleWebSocket(request, env) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("\u4E0D\u662FWebSocket\u8FDE\u63A5", { status: 400 });
  }
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  let pickupCode = null;
  let clientType = null;
  const sessionsStoreId = env.SESSIONS_STORE.idFromName("sessions");
  const sessionsStore = env.SESSIONS_STORE.get(sessionsStoreId);
  server.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case "create-session":
          clientType = "sender";
          const newPickupCode = await sessionsStore.createSession();
          pickupCode = newPickupCode;
          server.send(JSON.stringify({
            type: "create-session-response",
            data: { success: true, pickupCode: newPickupCode }
          }));
          break;
        case "join-session":
          pickupCode = data.data.pickupCode;
          clientType = "receiver";
          const joinSession = await sessionsStore.getSession(pickupCode);
          if (joinSession) {
            server.send(JSON.stringify({
              type: "session-joined",
              data: { success: true, pickupCode }
            }));
          } else {
            server.send(JSON.stringify({
              type: "session-joined",
              data: { success: false, message: "\u53D6\u4EF6\u7801\u65E0\u6548\u6216\u5DF2\u8FC7\u671F" }
            }));
            server.close();
          }
          break;
        case "file-info":
          const fileSession = await sessionsStore.getSession(data.data.pickupCode);
          if (fileSession) {
            await sessionsStore.updateFileInfo(data.data.pickupCode, data.data.fileInfo);
          }
          break;
        case "file-chunk":
          const chunkSession = await sessionsStore.getSession(data.data.pickupCode);
          if (chunkSession) {
            await sessionsStore.addFileChunk(
              data.data.pickupCode,
              data.data.chunkIndex,
              data.data.chunk,
              data.data.isLast
            );
            server.send(JSON.stringify({
              type: "chunk-ack",
              data: { pickupCode: data.data.pickupCode, chunkIndex: data.data.chunkIndex }
            }));
          }
          break;
        case "start-transfer":
          const startSession = await sessionsStore.getSession(data.data.pickupCode);
          if (startSession) {
            await sessionsStore.updateTransferStatus(data.data.pickupCode, true);
          }
          break;
        case "download-complete":
          await sessionsStore.cleanupSession(data.data.pickupCode);
          break;
      }
    } catch (error) {
      console.error("\u5904\u7406WebSocket\u6D88\u606F\u9519\u8BEF:", error);
    }
  };
  server.onclose = async () => {
    if (pickupCode) {
    }
  };
  server.onerror = (error) => {
    console.error("WebSocket\u9519\u8BEF:", error);
  };
  return new Response(null, { status: 101, webSocket: client });
}
__name(handleWebSocket, "handleWebSocket");
async function handleFileDownload(request, env) {
  const url = new URL(request.url);
  const pickupCode = url.searchParams.get("pickupCode");
  if (!pickupCode) {
    return new Response("\u7F3A\u5C11\u53D6\u4EF6\u7801", { status: 400 });
  }
  const sessionsStoreId = env.SESSIONS_STORE.idFromName("sessions");
  const sessionsStore = env.SESSIONS_STORE.get(sessionsStoreId);
  const session = await sessionsStore.getSession(pickupCode);
  if (!session || !session.fileInfo) {
    return new Response("\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u6587\u4EF6\u4FE1\u606F\u4E0D\u5B8C\u6574", { status: 404 });
  }
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of session.chunks) {
        if (chunk) {
          controller.enqueue(new Uint8Array(chunk));
        }
      }
      controller.close();
    }
  });
  return new Response(stream, {
    headers: {
      "Content-Disposition": `attachment; filename="${session.fileInfo.name}"`,
      "Content-Type": session.fileInfo.type || "application/octet-stream",
      "Content-Length": session.fileInfo.size
    }
  });
}
__name(handleFileDownload, "handleFileDownload");
function handleHealthCheck() {
  return new Response("OK", { status: 200 });
}
__name(handleHealthCheck, "handleHealthCheck");
var File_Rocket_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/health":
        return handleHealthCheck();
      case "/ws":
        return handleWebSocket(request, env);
      case "/download":
        return handleFileDownload(request, env);
      default:
        return await handleStaticFile(request, env);
    }
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

// .wrangler/tmp/bundle-zhyLSL/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = File_Rocket_default;

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

// .wrangler/tmp/bundle-zhyLSL/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
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
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
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
  SessionsStore,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map

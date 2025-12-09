var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// index.js
var activeSessions = /* @__PURE__ */ new Map();
var MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};
function getMimeType(filename) {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf("."));
  return MIME_TYPES[ext] || "application/octet-stream";
}
__name(getMimeType, "getMimeType");
async function handleStaticFile(request, env) {
  const url = new URL(request.url);
  let pathname = url.pathname;
  if (pathname === "/") {
    pathname = "/index.html";
  }
  const cleanPathname = pathname.split("?")[0];
  try {
    const file = await env.__STATIC_CONTENT.get(cleanPathname);
    if (file) {
      const mimeType = getMimeType(cleanPathname);
      return new Response(file, {
        headers: {
          "Content-Type": mimeType,
          "Cache-Control": "public, max-age=31536000"
        }
      });
    } else {
      return new Response("404 Not Found", { status: 404 });
    }
  } catch (error) {
    console.error("Static file error:", error);
    return new Response("404 Not Found", { status: 404 });
  }
}
__name(handleStaticFile, "handleStaticFile");
function generatePickupCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
__name(generatePickupCode, "generatePickupCode");
function handleWebSocket(request, env) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("\u4E0D\u662FWebSocket\u8FDE\u63A5", { status: 400 });
  }
  const { 0: client, 1: server } = new WebSocketPair();
  client.accept();
  let pickupCode = null;
  let clientType = null;
  client.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      switch (data.type) {
        case "create-session":
          pickupCode = generatePickupCode();
          clientType = "sender";
          const session = {
            pickupCode,
            sender: client,
            receiver: null,
            fileInfo: null,
            chunks: [],
            isTransferring: false,
            startTime: Date.now()
          };
          activeSessions.set(pickupCode, session);
          client.send(JSON.stringify({
            type: "create-session-response",
            data: { success: true, pickupCode }
          }));
          break;
        case "join-session":
          pickupCode = data.data.pickupCode;
          clientType = "receiver";
          const joinSession = activeSessions.get(pickupCode);
          if (joinSession && joinSession.receiver === null) {
            joinSession.receiver = client;
            if (joinSession.sender) {
              joinSession.sender.send(JSON.stringify({
                type: "receiver-connected",
                data: { pickupCode }
              }));
            }
            client.send(JSON.stringify({
              type: "session-joined",
              data: { success: true, pickupCode }
            }));
          } else {
            client.send(JSON.stringify({
              type: "session-joined",
              data: { success: false, message: "\u53D6\u4EF6\u7801\u65E0\u6548\u6216\u5DF2\u8FC7\u671F" }
            }));
            client.close();
          }
          break;
        case "file-info":
          const fileSession = activeSessions.get(data.data.pickupCode);
          if (fileSession && fileSession.sender === client) {
            fileSession.fileInfo = data.data.fileInfo;
            if (fileSession.receiver) {
              fileSession.receiver.send(JSON.stringify({
                type: "file-info",
                data: { pickupCode: data.data.pickupCode, fileInfo: data.data.fileInfo }
              }));
            }
          }
          break;
        case "file-chunk":
          const chunkSession = activeSessions.get(data.data.pickupCode);
          if (chunkSession && chunkSession.sender === client) {
            chunkSession.chunks[data.data.chunkIndex] = data.data.chunk;
            client.send(JSON.stringify({
              type: "chunk-ack",
              data: { pickupCode: data.data.pickupCode, chunkIndex: data.data.chunkIndex }
            }));
            if (data.data.isLast) {
              chunkSession.isTransferring = false;
              if (chunkSession.sender) {
                chunkSession.sender.send(JSON.stringify({
                  type: "transfer-complete",
                  data: { pickupCode: data.data.pickupCode }
                }));
              }
              if (chunkSession.receiver) {
                chunkSession.receiver.send(JSON.stringify({
                  type: "transfer-complete",
                  data: { pickupCode: data.data.pickupCode }
                }));
              }
            }
          }
          break;
        case "start-transfer":
          const startSession = activeSessions.get(data.data.pickupCode);
          if (startSession && startSession.receiver === client) {
            startSession.isTransferring = true;
            if (startSession.sender) {
              startSession.sender.send(JSON.stringify({
                type: "start-transfer",
                data: { pickupCode: data.data.pickupCode }
              }));
            }
          }
          break;
        case "download-complete":
          const completeSession = activeSessions.get(data.data.pickupCode);
          if (completeSession) {
            activeSessions.delete(data.data.pickupCode);
          }
          break;
      }
    } catch (error) {
      console.error("\u5904\u7406WebSocket\u6D88\u606F\u9519\u8BEF:", error);
    }
  };
  client.onclose = () => {
    if (pickupCode) {
      const session = activeSessions.get(pickupCode);
      if (session) {
        if (clientType === "sender") {
          session.sender = null;
          if (session.receiver) {
            session.receiver.send(JSON.stringify({
              type: "sender-disconnected",
              data: { pickupCode }
            }));
          }
        } else if (clientType === "receiver") {
          session.receiver = null;
          if (session.sender) {
            session.sender.send(JSON.stringify({
              type: "receiver-disconnected",
              data: { pickupCode }
            }));
          }
        }
        if (!session.sender && !session.receiver) {
          activeSessions.delete(pickupCode);
        }
      }
    }
  };
  client.onerror = (error) => {
    console.error("WebSocket\u9519\u8BEF:", error);
  };
  return new Response(null, { status: 101, webSocket: server });
}
__name(handleWebSocket, "handleWebSocket");
async function handleFileDownload(request, env) {
  const url = new URL(request.url);
  const pickupCode = url.searchParams.get("pickupCode");
  if (!pickupCode) {
    return new Response("\u7F3A\u5C11\u53D6\u4EF6\u7801", { status: 400 });
  }
  const session = activeSessions.get(pickupCode);
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
var index_default = {
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

// D:/Programes/nvm/nvm/v22.14.0/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
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

// D:/Programes/nvm/nvm/v22.14.0/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
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

// .wrangler/tmp/bundle-FjxqQD/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = index_default;

// D:/Programes/nvm/nvm/v22.14.0/node_modules/wrangler/templates/middleware/common.ts
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

// .wrangler/tmp/bundle-FjxqQD/middleware-loader.entry.ts
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
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map

// Cloudflare Workers 主脚本

// 导入DurableObject基类
import { DurableObject } from "cloudflare:workers";

// Durable Object 类 - 用于存储会话状态和WebSocket连接
class SessionsStore extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // 存储会话信息
    this.connections = new Map(); // 存储WebSocket连接
    this.initialized = false;
  }
  
  // 初始化方法，加载会话
  async initialize() {
    if (!this.initialized) {
      await this.state.blockConcurrencyWhile(async () => {
        const stored = await this.state.storage.get('sessions');
        if (stored) {
          this.sessions = new Map(JSON.parse(stored));
        }
        this.initialized = true;
      });
    }
  }

  // 保存会话到持久化存储
  async saveSessions() {
    await this.state.storage.put('sessions', JSON.stringify(Array.from(this.sessions.entries())));
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
  
  // 添加文件块
  async addFileChunk(pickupCode, chunkIndex, chunk, isLast) {
    await this.initialize();
    const session = this.sessions.get(pickupCode);
    if (session) {
      // 初始化文件块数组
      if (!session.chunks) {
        session.chunks = [];
      }
      
      // 存储文件块
      session.chunks[chunkIndex] = chunk;
      
      // 如果是最后一个块，标记为已完成
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

  // 处理WebSocket连接
  async handleWebSocket(server) {
    // 接受WebSocket连接
    server.accept();

    // 存储客户端信息
    let pickupCode = null;
    let clientType = null; // 'sender' 或 'receiver'
    let connectionId = crypto.randomUUID(); // 生成唯一连接ID

    // 消息处理
    server.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        
        // 根据消息类型处理
        switch (data.type) {
          case 'create-session':
            // 创建新会话
            clientType = 'sender';
            
            // 保存会话到Durable Object并获取生成的取件码
            const newPickupCode = await this.createSession();
            
            // 更新本地pickupCode
            pickupCode = newPickupCode;
            
            // 将连接添加到connections
            this.connections.set(connectionId, { server, pickupCode, clientType });
            
            // 回复创建成功
            server.send(JSON.stringify({
              type: 'create-session-response',
              data: { success: true, pickupCode: newPickupCode }
            }));
            break;
            
          case 'join-session':
            // 加入会话
            pickupCode = data.data.pickupCode;
            clientType = 'receiver';
            
            // 从Durable Object获取会话
            const joinSession = await this.getSession(pickupCode);
            
            if (joinSession) {
              // 将连接添加到connections
              this.connections.set(connectionId, { server, pickupCode, clientType });
              
              // 回复加入成功
              server.send(JSON.stringify({
                type: 'session-joined',
                data: { success: true, pickupCode: pickupCode }
              }));
              
              // 如果有文件信息，立即发送给接收方
              if (joinSession.fileInfo) {
                server.send(JSON.stringify({
                  type: 'file-info',
                  data: {
                    pickupCode: pickupCode,
                    fileInfo: joinSession.fileInfo
                  }
                }));
              }
              
              // 通知发送方接收方已连接
              this.notifySenderReceiverConnected(pickupCode);
            } else {
              // 会话不存在
              server.send(JSON.stringify({
                type: 'session-joined',
                data: { success: false, message: '取件码无效或已过期' }
              }));
              
              // 关闭连接
              server.close();
            }
            break;
            
          case 'file-info':
            // 接收文件信息
            const fileSession = await this.getSession(data.data.pickupCode);
            
            if (fileSession) {
              // 更新文件信息到Durable Object
              await this.updateFileInfo(data.data.pickupCode, data.data.fileInfo);
            }
            break;
            
          case 'file-chunk':
            // 接收文件块
            const chunkSession = await this.getSession(data.data.pickupCode);
            
            if (chunkSession) {
              // 存储文件块到Durable Object
              await this.addFileChunk(
                data.data.pickupCode,
                data.data.chunkIndex,
                data.data.chunk,
                data.data.isLast
              );
              
              // 发送确认
              server.send(JSON.stringify({
                type: 'chunk-ack',
                data: { pickupCode: data.data.pickupCode, chunkIndex: data.data.chunkIndex }
              }));
              
              // 转发文件块给接收端
              for (const [id, conn] of this.connections.entries()) {
                if (conn.pickupCode === data.data.pickupCode && conn.clientType === 'receiver') {
                  try {
                    conn.server.send(JSON.stringify({
                      type: 'file-chunk',
                      data: data.data
                    }));
                  } catch (error) {
                    console.error('向接收端转发文件块失败:', error);
                  }
                }
              }
            }
            break;
            
          case 'start-transfer':
            // 开始传输文件
            const startSession = await this.getSession(data.data.pickupCode);
            
            if (startSession) {
              // 更新传输状态
              await this.updateTransferStatus(data.data.pickupCode, true);
              
              // 通知发送方开始传输
              this.forwardToSender(data.data.pickupCode, JSON.stringify({
                type: 'start-transfer'
              }));
            }
            break;
            
          case 'download-complete':
            // 下载完成确认
            await this.cleanupSession(data.data.pickupCode);
            break;
        }
      } catch (error) {
        console.error('处理WebSocket消息错误:', error);
      }
    };

    // 处理连接关闭
    server.onclose = () => {
      // 从connections中移除连接
      this.connections.delete(connectionId);
    };
    
    // 处理连接错误
    server.onerror = (error) => {
      console.error('WebSocket连接错误:', error);
      // 从connections中移除连接
      this.connections.delete(connectionId);
    };
  }

  // 通知发送方接收方已连接
  notifySenderReceiverConnected(pickupCode) {
    this.forwardToSender(pickupCode, JSON.stringify({
      type: 'receiver-connected'
    }));
  }

  // 向发送方转发消息
  forwardToSender(pickupCode, message) {
    // 查找所有发送方连接
    for (const [id, conn] of this.connections.entries()) {
      if (conn.pickupCode === pickupCode && conn.clientType === 'sender') {
        try {
          conn.server.send(message);
        } catch (error) {
          console.error('向发送方转发消息失败:', error);
        }
      }
    }
  }

  // 清理会话
  async cleanupSession(pickupCode) {
    await this.initialize();
    this.sessions.delete(pickupCode);
    
    // 清理相关的WebSocket连接
    for (const [id, conn] of this.connections.entries()) {
      if (conn.pickupCode === pickupCode) {
        try {
          conn.server.close();
        } catch (error) {
          console.error('关闭WebSocket连接错误:', error);
        }
        this.connections.delete(id);
      }
    }
    
    await this.saveSessions();
  }

  // 处理WebSocket请求和其他HTTP请求
  async fetch(request) {
    // 检查是否是WebSocket连接
    if (request.headers.get('Upgrade') === 'websocket') {
      // 创建WebSocket对
      const { 0: client, 1: server } = new WebSocketPair();
      
      // 处理WebSocket连接
      await this.handleWebSocket(server);
      
      // 返回WebSocket响应
      return new Response(null, {
        status: 101,
        webSocket: client,
      });
    }
    
    // 处理其他HTTP请求
    const url = new URL(request.url);
    
    if (url.pathname === '/session' && request.method === 'POST') {
      // 处理获取会话的请求
      const body = await request.json();
      const session = await this.getSession(body.pickupCode);
      return new Response(JSON.stringify(session), {
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    return new Response('请求类型不支持', { status: 400 });
  }
}

// MIME类型映射
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// 获取文件的MIME类型
function getMimeType(filename) {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// 处理静态文件请求
async function handleStaticFile(request, env) {
  try {
    // 使用新的ASSETS绑定处理静态文件请求
    return await env.ASSETS.fetch(request);
  } catch (error) {
    console.error('Static file error:', error);
    // 如果静态文件处理失败，尝试返回index.html
    if (new URL(request.url).pathname === '/') {
      try {
        // 直接从ASSETS获取index.html
        const indexResponse = await env.ASSETS.fetch(new Request(
          new URL('/index.html', request.url),
          { method: 'GET' }
        ));
        return indexResponse;
      } catch (e) {
        console.error('Failed to fetch index.html:', e);
      }
    }
    return new Response('404 Not Found', { status: 404 });
  }
}

// 生成6位取件码
function generatePickupCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 处理WebSocket连接
function handleWebSocket(request, env) {
  // 检查是否是WebSocket连接
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('不是WebSocket连接', { status: 400 });
  }

  // 获取Durable Object实例
  const sessionsStoreId = env.SESSIONS_STORE.idFromName('sessions');
  const sessionsStore = env.SESSIONS_STORE.get(sessionsStoreId);

  // 将WebSocket请求转发给Durable Object
  return sessionsStore.fetch(request);
}

// 处理文件下载请求
async function handleFileDownload(request, env) {
  const url = new URL(request.url);
  const pickupCode = url.pathname.split('/').pop();
  
  if (!pickupCode) {
    return new Response('缺少取件码', { status: 400 });
  }
  
  // 获取Durable Object实例
  const sessionsStoreId = env.SESSIONS_STORE.idFromName('sessions');
  const sessionsStore = env.SESSIONS_STORE.get(sessionsStoreId);
  
  // 创建一个获取会话的请求
  const sessionRequest = new Request('http://dummy/session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ pickupCode })
  });
  
  // 从Durable Object获取会话
  const sessionResponse = await sessionsStore.fetch(sessionRequest);
  const session = await sessionResponse.json();
  
  if (!session || !session.fileInfo) {
    return new Response('会话不存在或文件信息不完整', { status: 404 });
  }
  
  // 创建ReadableStream来发送文件内容
  const stream = new ReadableStream({
    start(controller) {
      // 发送所有文件块
      for (const chunk of session.chunks) {
        if (chunk) {
          controller.enqueue(new Uint8Array(chunk));
        }
      }
      controller.close();
    }
  });
  
  // 创建响应
  return new Response(stream, {
    headers: {
      'Content-Disposition': `attachment; filename="${session.fileInfo.name}"`,
      'Content-Type': session.fileInfo.type || 'application/octet-stream',
      'Content-Length': session.fileInfo.size
    }
  });
}

// 健康检查
function handleHealthCheck() {
  return new Response('OK', { status: 200 });
}

// 导出Durable Object类
export { SessionsStore };

// 主请求处理函数
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 路由请求
    switch (url.pathname) {
      case '/health':
        // 健康检查
        return handleHealthCheck();
        
      case '/ws':
        // WebSocket连接
        try {
          return handleWebSocket(request, env);
        } catch (error) {
          console.error('WebSocket处理错误:', error);
          return new Response('WebSocket连接失败', { status: 500 });
        }
        
      case '/download':
      case '/api/download':
        // 文件下载
        return handleFileDownload(request, env);
        
      default:
        // 其他请求由静态文件处理
        return await handleStaticFile(request, env);
    }
  }
};

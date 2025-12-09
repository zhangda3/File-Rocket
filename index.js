// Cloudflare Workers 主脚本

// 存储活跃会话
const activeSessions = new Map();

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
  const url = new URL(request.url);
  let pathname = url.pathname;

  // 如果路径是根目录，返回index.html
  if (pathname === '/') {
    pathname = '/index.html';
  }

  // 移除可能的查询参数
  const cleanPathname = pathname.split('?')[0];

  try {
    // 获取文件内容
    const file = await env.__STATIC_CONTENT.get(cleanPathname);

    if (file) {
      // 获取MIME类型
      const mimeType = getMimeType(cleanPathname);
      // 返回文件内容
      return new Response(file, {
        headers: {
          'Content-Type': mimeType,
          'Cache-Control': 'public, max-age=31536000'
        }
      });
    } else {
      // 文件不存在
      return new Response('404 Not Found', { status: 404 });
    }
  } catch (error) {
    console.error('Static file error:', error);
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

  // 创建WebSocket对
  const { 0: client, 1: server } = new WebSocketPair();

  // 处理客户端WebSocket连接
  client.accept();

  // 存储客户端信息
  let pickupCode = null;
  let clientType = null; // 'sender' 或 'receiver'

  // 消息处理
  client.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      
      // 根据消息类型处理
      switch (data.type) {
        case 'create-session':
          // 创建新会话
          pickupCode = generatePickupCode();
          clientType = 'sender';
          
          const session = {
            pickupCode: pickupCode,
            sender: client,
            receiver: null,
            fileInfo: null,
            chunks: [],
            isTransferring: false,
            startTime: Date.now()
          };
          
          activeSessions.set(pickupCode, session);
          
          // 回复创建成功
          client.send(JSON.stringify({
            type: 'create-session-response',
            data: { success: true, pickupCode: pickupCode }
          }));
          break;
          
        case 'join-session':
          // 加入会话
          pickupCode = data.data.pickupCode;
          clientType = 'receiver';
          
          const joinSession = activeSessions.get(pickupCode);
          
          if (joinSession && joinSession.receiver === null) {
            // 加入成功
            joinSession.receiver = client;
            
            // 通知发送方有接收方连接
            if (joinSession.sender) {
              joinSession.sender.send(JSON.stringify({
                type: 'receiver-connected',
                data: { pickupCode: pickupCode }
              }));
            }
            
            // 回复加入成功
            client.send(JSON.stringify({
              type: 'session-joined',
              data: { success: true, pickupCode: pickupCode }
            }));
          } else {
            // 加入失败
            client.send(JSON.stringify({
              type: 'session-joined',
              data: { success: false, message: '取件码无效或已过期' }
            }));
            
            // 关闭连接
            client.close();
          }
          break;
          
        case 'file-info':
          // 接收文件信息
          const fileSession = activeSessions.get(data.data.pickupCode);
          
          if (fileSession && fileSession.sender === client) {
            fileSession.fileInfo = data.data.fileInfo;
            
            // 转发文件信息给接收方
            if (fileSession.receiver) {
              fileSession.receiver.send(JSON.stringify({
                type: 'file-info',
                data: { pickupCode: data.data.pickupCode, fileInfo: data.data.fileInfo }
              }));
            }
          }
          break;
          
        case 'file-chunk':
          // 接收文件块
          const chunkSession = activeSessions.get(data.data.pickupCode);
          
          if (chunkSession && chunkSession.sender === client) {
            // 存储文件块
            chunkSession.chunks[data.data.chunkIndex] = data.data.chunk;
            
            // 发送确认
            client.send(JSON.stringify({
              type: 'chunk-ack',
              data: { pickupCode: data.data.pickupCode, chunkIndex: data.data.chunkIndex }
            }));
            
            // 如果是最后一块，通知接收方下载完成
            if (data.data.isLast) {
              chunkSession.isTransferring = false;
              
              // 通知发送方传输完成
              if (chunkSession.sender) {
                chunkSession.sender.send(JSON.stringify({
                  type: 'transfer-complete',
                  data: { pickupCode: data.data.pickupCode }
                }));
              }
              
              // 通知接收方下载完成
              if (chunkSession.receiver) {
                chunkSession.receiver.send(JSON.stringify({
                  type: 'transfer-complete',
                  data: { pickupCode: data.data.pickupCode }
                }));
              }
            }
          }
          break;
          
        case 'start-transfer':
          // 开始传输文件
          const startSession = activeSessions.get(data.data.pickupCode);
          
          if (startSession && startSession.receiver === client) {
            startSession.isTransferring = true;
            
            // 通知发送方开始传输
            if (startSession.sender) {
              startSession.sender.send(JSON.stringify({
                type: 'start-transfer',
                data: { pickupCode: data.data.pickupCode }
              }));
            }
          }
          break;
          
        case 'download-complete':
          // 下载完成确认
          const completeSession = activeSessions.get(data.data.pickupCode);
          
          if (completeSession) {
            // 清理会话
            activeSessions.delete(data.data.pickupCode);
          }
          break;
      }
    } catch (error) {
      console.error('处理WebSocket消息错误:', error);
    }
  };

  // 处理连接关闭
  client.onclose = () => {
    if (pickupCode) {
      const session = activeSessions.get(pickupCode);
      
      if (session) {
        if (clientType === 'sender') {
          // 发送方断开连接
          session.sender = null;
          
          // 通知接收方
          if (session.receiver) {
            session.receiver.send(JSON.stringify({
              type: 'sender-disconnected',
              data: { pickupCode: pickupCode }
            }));
          }
        } else if (clientType === 'receiver') {
          // 接收方断开连接
          session.receiver = null;
          
          // 通知发送方
          if (session.sender) {
            session.sender.send(JSON.stringify({
              type: 'receiver-disconnected',
              data: { pickupCode: pickupCode }
            }));
          }
        }
        
        // 如果会话没有任何连接，清理会话
        if (!session.sender && !session.receiver) {
          activeSessions.delete(pickupCode);
        }
      }
    }
  };

  // 处理错误
  client.onerror = (error) => {
    console.error('WebSocket错误:', error);
  };

  // 返回服务器端WebSocket作为响应
  return new Response(null, { status: 101, webSocket: server });
}

// 处理文件下载请求
async function handleFileDownload(request, env) {
  const url = new URL(request.url);
  const pickupCode = url.searchParams.get('pickupCode');
  
  if (!pickupCode) {
    return new Response('缺少取件码', { status: 400 });
  }
  
  const session = activeSessions.get(pickupCode);
  
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
        return handleWebSocket(request, env);
        
      case '/download':
        // 文件下载
        return handleFileDownload(request, env);
        
      default:
        // 其他请求由静态文件处理
        return await handleStaticFile(request, env);
    }
  }
};

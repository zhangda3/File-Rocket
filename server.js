const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const path = require('path');

const app = express();
const server = http.createServer(app);
server.setTimeout(0); // 禁用超时，确保大文件传输不断开

const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e8, // 100MB buffer
  pingTimeout: 60000, // 60秒超时
  pingInterval: 25000, // 25秒ping间隔
  transports: ['websocket', 'polling'] // 支持websocket和polling
});

const PORT = process.env.PORT || 3000;

// 存储活跃的传输会话
const activeSessions = new Map();

// 配置静态文件服务
app.use(express.static('public'));
app.use(express.json());

// 生成4位随机取件码（数字+大写字母）
function generatePickupCode() {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // 确保取件码唯一
  if (activeSessions.has(code)) {
    return generatePickupCode();
  }
  return code;
}

// Socket.IO 连接处理
io.on('connection', (socket) => {
  console.log(`客户端连接: ${socket.id}`);

  // 创建文件传输会话
  socket.on('create-session', (callback) => {
    const pickupCode = generatePickupCode();
    activeSessions.set(pickupCode, {
      senderId: socket.id,
      receiverId: null,
      senderSocket: socket,
      receiverSocket: null,
      fileInfo: null,
      createdAt: Date.now()
    });
    
    socket.join(`session-${pickupCode}`);
    console.log(`[${pickupCode}] 创建传输会话 (发送端: ${socket.id}) - 当前活跃会话: ${activeSessions.size}`);
    
    callback({ success: true, pickupCode });
  });

  // 加入接收会话
  socket.on('join-session', (data, callback) => {
    const { pickupCode } = data;
    const session = activeSessions.get(pickupCode);
    
    if (!session) {
      callback({ success: false, message: '无效的取件码' });
      return;
    }
    
    // 如果是同一个socket的重复请求，直接返回成功
    if (session.receiverId === socket.id) {
      console.log(`重复的join-session请求: ${pickupCode} from ${socket.id}`);
      callback({ success: true });
      
      // 如果文件信息已存在，重新发送给接收方
      if (session.fileInfo) {
        socket.emit('file-info', session.fileInfo);
      }
      return;
    }
    
    if (session.receiverId) {
      callback({ success: false, message: '该取件码已被使用' });
      return;
    }
    
    // 更新会话信息
    session.receiverId = socket.id;
    session.receiverSocket = socket;
    
    socket.join(`session-${pickupCode}`);
    
    // 通知发送方有接收方连接
    if (session.senderSocket) {
      session.senderSocket.emit('receiver-connected', {
        pickupCode: pickupCode,
        receiverId: socket.id
      });
    }
    
    // 如果文件信息已存在，立即发送给接收方
    if (session.fileInfo) {
      socket.emit('file-info', session.fileInfo);
    }
    
    console.log(`[${pickupCode}] 接收方加入会话 (接收端: ${socket.id}, 发送端: ${session.senderId}) - 当前活跃会话: ${activeSessions.size}`);
    callback({ success: true });
  });

  // 处理文件信息
  socket.on('file-info', (data) => {
    const { pickupCode, fileInfo } = data;
    const session = activeSessions.get(pickupCode);
    
    if (session && session.senderId === socket.id) {
      session.fileInfo = fileInfo;
      console.log(`[${pickupCode}] 存储文件信息: ${fileInfo.name}`);
      
      // 如果接收方已连接，发送文件信息（附带 pickupCode）
      if (session.receiverSocket) {
        session.receiverSocket.emit('file-info', {
          pickupCode: pickupCode,
          ...fileInfo
        });
        console.log(`[${pickupCode}] 向接收端发送文件信息`);
      }
    } else {
      console.log(`[${pickupCode}] file-info验证失败`);
    }
  });

  // 处理文件数据块传输
  socket.on('file-chunk', (data) => {
    const { pickupCode, chunk, chunkIndex, totalChunks, isLast } = data;
    const session = activeSessions.get(pickupCode);
    
    if (session && session.senderId === socket.id) {
      // 检查是否有活跃的 HTTP 下载响应流
      if (session.downloadResponse && !session.downloadResponse.writableEnded) {
        
        // 关键修复：将 ArrayBuffer 正确转换为 Buffer
        const buffer = Buffer.from(chunk);
        
        // 初始化字节计数器（如果是第一个块）
        if (!session.totalBytesTransferred) {
            session.totalBytesTransferred = 0;
        }
        session.totalBytesTransferred += buffer.length;
        
        // 写入数据到 HTTP 响应流
        const canContinue = session.downloadResponse.write(buffer);
        
        // 流控/背压机制：只有当缓冲区未满或drain事件触发时才发送ACK
        if (canContinue) {
            socket.emit('chunk-ack', { pickupCode, chunkIndex });
        } else {
            session.downloadResponse.once('drain', () => {
                socket.emit('chunk-ack', { pickupCode, chunkIndex });
            });
        }
        
        // 计算并广播进度（包含实际字节数用于速度计算）
        const progress = ((chunkIndex + 1) / totalChunks) * 100;
        const bytesTransferred = session.totalBytesTransferred;
        
        // 每隔10个chunk或者是最后一块才广播，减少流量
        if (chunkIndex % 10 === 0 || isLast) {
             io.to(`session-${pickupCode}`).emit('transfer-progress', { 
                pickupCode,
                progress,
                chunkIndex,
                totalChunks,
                bytesTransferred  // 新增：实际传输的字节数
            });
        }

        if (isLast) {
            console.log(`[${pickupCode}] 所有数据传输完成 (${session.totalBytesTransferred} bytes)，结束HTTP流`);
            session.downloadResponse.end();
        }
      } else {
        // 接收端可能断开了
        console.log(`[${pickupCode}] 没有活跃的下载流，停止传输`);
        socket.emit('receiver-disconnected', { pickupCode });
      }
    } else {
      // 验证失败
    }
  });

  // 处理接收端下载完成确认
  socket.on('download-complete', (data) => {
    const { pickupCode } = data;
    const session = activeSessions.get(pickupCode);
    
    if (session && session.receiverId === socket.id && session.senderSocket) {
      // 通知发送方传输真正完成
      session.senderSocket.emit('transfer-complete', { pickupCode });
      console.log(`传输全部完成: ${pickupCode}`);
      
      // 清理会话
      setTimeout(() => {
        activeSessions.delete(pickupCode);
      }, 2000);
    }
  });

  // 处理接收方确认传输
  socket.on('accept-transfer', (data) => {
    const { pickupCode } = data;
    const session = activeSessions.get(pickupCode);
    
    if (session && session.receiverId === socket.id) {
        // 仅记录日志，实际传输由HTTP请求触发
        console.log(`[${pickupCode}] 接收方点击接收，准备发起HTTP请求`);
    }
  });

  // 处理传输状态更新（接收端发送进度，服务器转发给上传端）
  // 这个监听器现在主要用于接收端断开等状态，进度由服务器内部计算广播
  socket.on('transfer-progress', (data) => {
     // 忽略客户端发来的进度，使用服务器计算的进度
  });

  // 转发接收端下载速度给发送端
  socket.on('transfer-speed', (data) => {
    const { pickupCode, speed } = data;
    const session = activeSessions.get(pickupCode);
    
    if (session && session.receiverId === socket.id && session.senderSocket) {
      // 转发时附带 pickupCode，确保发送端能正确识别
      session.senderSocket.emit('transfer-speed', { 
        pickupCode: pickupCode,
        speed: speed 
      });
    } else {
      console.log(`[${pickupCode}] transfer-speed验证失败: session存在=${!!session}, receiverId匹配=${session?.receiverId === socket.id}`);
    }
  });

  // 处理断开连接
  socket.on('disconnect', () => {
    console.log(`客户端断开连接: ${socket.id}`);
    
    // 查找并清理相关会话
    for (const [pickupCode, session] of activeSessions.entries()) {
      if (session.senderId === socket.id || session.receiverId === socket.id) {
        const role = session.senderId === socket.id ? '发送端' : '接收端';
        console.log(`[${pickupCode}] ${role}断开连接 - 活跃会话: ${activeSessions.size}`);
        
        // 通知其他参与者连接已断开
        io.to(`session-${pickupCode}`).emit('connection-lost', { pickupCode });
        
        // 如果是接收方断开，专门通知发送方（用于中断传输）
        if (session.receiverId === socket.id && session.senderSocket && session.senderSocket.connected) {
          console.log(`[${pickupCode}] 通知发送端接收方已断开`);
          session.senderSocket.emit('receiver-disconnected', { pickupCode });
          session.receiverId = null;
          session.receiverSocket = null;
        }
        
        // 如果是发送方断开，立即清理会话
        if (session.senderId === socket.id) {
          console.log(`[${pickupCode}] 清理会话（发送端断开）`);
          activeSessions.delete(pickupCode);
        }
        break;
      }
    }
  });
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    activeSessions: activeSessions.size,
    timestamp: new Date().toISOString()
  });
});

// 主页面路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 新增：HTTP流式下载接口
app.get('/api/download/:code', (req, res) => {
    const pickupCode = req.params.code;
    const session = activeSessions.get(pickupCode);

    if (!session || !session.fileInfo) {
        return res.status(404).send('链接已失效或文件信息缺失');
    }

    // 设置下载头
    const fileName = encodeURIComponent(session.fileInfo.name);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`);
    res.setHeader('Content-Type', session.fileInfo.type || 'application/octet-stream');
    if (session.fileInfo.size) {
        res.setHeader('Content-Length', session.fileInfo.size);
    }

    // 存储响应对象到会话中，以便Socket接收到数据时写入
    session.downloadResponse = res;
    console.log(`[${pickupCode}] HTTP下载请求已建立，准备流式传输`);

    // 通知发送端开始发送数据
    if (session.senderSocket) {
        session.senderSocket.emit('start-transfer', { pickupCode });
    }

    // 监听连接关闭
    req.on('close', () => {
        if (!res.writableEnded) {
            console.log(`[${pickupCode}] 接收端HTTP连接中断`);
            if (session.senderSocket) {
                session.senderSocket.emit('receiver-disconnected', { pickupCode });
            }
            session.downloadResponse = null;
        }
    });
});

// 清理过期会话（每5分钟执行一次）
setInterval(() => {
  const now = Date.now();
  const expiredTime = 30 * 60 * 1000; // 30分钟过期
  
  for (const [pickupCode, session] of activeSessions.entries()) {
    if (now - session.createdAt > expiredTime) {
      console.log(`清理过期会话: ${pickupCode}`);
      activeSessions.delete(pickupCode);
    }
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`File-Rocket 服务器运行在端口 ${PORT}`);
  console.log(`访问地址: http://localhost:${PORT}`);
});

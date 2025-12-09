// WebSocket 连接
let socket;
let isConnected = false;

function connectWebSocket() {
  // 检测当前页面协议，使用对应的WebSocket协议
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  
  socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    console.log('WebSocket连接已建立');
    isConnected = true;
  };
  
  socket.onclose = () => {
    console.log('WebSocket连接已关闭');
    isConnected = false;
    // 尝试重连
    setTimeout(connectWebSocket, 3000);
  };
  
  socket.onerror = (error) => {
    console.error('WebSocket错误:', error);
  };
  
  // 消息处理
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      // 根据消息类型分发处理
      if (data.type === 'create-session-response') {
        handleCreateSessionResponse(data.data);
      } else if (data.type === 'receiver-connected') {
        handleReceiverConnected(data.data);
      } else if (data.type === 'start-transfer') {
        handleStartTransfer(data.data);
      } else if (data.type === 'transfer-complete') {
        handleTransferComplete(data.data);
      } else if (data.type === 'connection-lost') {
        handleConnectionLost(data.data);
      } else if (data.type === 'transfer-progress') {
        handleTransferProgress(data.data);
      } else if (data.type === 'transfer-speed') {
        handleTransferSpeed(data.data);
      } else if (data.type === 'receiver-disconnected') {
        handleReceiverDisconnected(data.data);
      } else if (data.type === 'chunk-ack') {
        handleChunkAck(data.data);
      }
    } catch (error) {
      console.error('解析WebSocket消息错误:', error);
    }
  };
}

// 初始化WebSocket连接
connectWebSocket();

// 全局变量
let selectedFile = null;
let pickupCode = null;
let transferStartTime = null;
let isTransferring = false;

// DOM 元素
const fileInput = document.getElementById('fileInput');
const fileDropZone = document.getElementById('fileDropZone');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const pickupCodeDisplay = document.getElementById('pickupCode');
const statusText = document.getElementById('statusText');
const statusIndicator = document.getElementById('statusIndicator');
const progressFill = document.getElementById('progressFill');
const progressPercent = document.getElementById('progressPercent');
const transferSpeed = document.getElementById('transferSpeed');

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    setupFileDropZone();
});

// 设置拖拽上传
function setupFileDropZone() {
    fileDropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        fileDropZone.classList.add('drag-over');
    });

    fileDropZone.addEventListener('dragleave', () => {
        fileDropZone.classList.remove('drag-over');
    });

    fileDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        fileDropZone.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleFileSelect(files[0]);
        }
    });

    fileDropZone.addEventListener('click', selectFile);
    
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileSelect(e.target.files[0]);
        }
    });
}

// 选择文件
function selectFile() {
    fileInput.click();
}

// 处理文件选择
function handleFileSelect(file) {
    selectedFile = file;
    
    // 显示文件信息
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);
    
    // 切换到生成取件码阶段
    showStage('code-generate-stage');
}

// 生成取件码
function generateCode() {
    if (!selectedFile) return;
    
    const generateBtn = document.getElementById('generateCodeBtn');
    generateBtn.disabled = true;
    generateBtn.textContent = '生成中...';
    
    // 请求创建传输会话
    socket.send(JSON.stringify({
        type: 'create-session'
    }));
}

// 处理创建会话响应
function handleCreateSessionResponse(response) {
    const generateBtn = document.getElementById('generateCodeBtn');
    
    if (response.success) {
        pickupCode = response.pickupCode;
        pickupCodeDisplay.textContent = pickupCode;
        
        // 发送文件信息
        socket.send(JSON.stringify({
            type: 'file-info',
            data: {
                pickupCode: pickupCode,
                fileInfo: {
                    name: selectedFile.name,
                    size: selectedFile.size,
                    type: selectedFile.type
                }
            }
        }));
        
        // 切换到等待连接阶段
        showStage('waiting-stage');
    } else {
        alert('生成取件码失败，请重试');
        generateBtn.disabled = false;
        generateBtn.textContent = '生成取件码';
    }
}

// WebSocket事件处理函数
function handleReceiverConnected(data) {
    const { pickupCode: connectedPickupCode } = data;
    
    // 严格验证：只处理属于当前房间的连接事件
    if (connectedPickupCode && connectedPickupCode !== pickupCode) {
        console.log(`[房间隔离] 忽略不属于当前房间的连接: ${connectedPickupCode} (当前: ${pickupCode})`);
        return;
    }
    
    statusText.textContent = '接收方已连接，等待确认...';
    statusIndicator.style.background = '#28a745';
}

function handleStartTransfer(data) {
    const { pickupCode: transferPickupCode } = data;
    
    // 严格验证：只处理属于当前房间的开始传输指令
    if (transferPickupCode && transferPickupCode !== pickupCode) {
        console.log(`[房间隔离] 忽略不属于当前房间的开始传输: ${transferPickupCode} (当前: ${pickupCode})`);
        return;
    }
    
    statusText.textContent = '开始传输文件...';
    setTimeout(() => {
        startFileTransfer();
    }, 500);
}

function handleTransferComplete(data) {
    const { pickupCode: completePickupCode } = data;
    
    // 严格验证：只处理属于当前房间的完成事件
    if (completePickupCode && completePickupCode !== pickupCode) {
        console.log(`[房间隔离] 忽略不属于当前房间的完成事件: ${completePickupCode} (当前: ${pickupCode})`);
        return;
    }
    
    // 传输真正完成，显示完成页面
    setTimeout(() => {
        showStage('complete-stage');
    }, 500);
}

function handleConnectionLost(data) {
    const { pickupCode: lostPickupCode } = data || {};
    
    // 验证是否属于当前房间
    if (lostPickupCode && lostPickupCode !== pickupCode) {
        console.log(`[房间隔离] 忽略不属于当前房间的断连: ${lostPickupCode} (当前: ${pickupCode})`);
        return;
    }
    
    isTransferring = false;
    statusText.textContent = '连接已断开';
    statusIndicator.style.background = '#dc3545';
}

function handleTransferProgress(data) {
    const { pickupCode: progressPickupCode, progress, bytesTransferred } = data;
    
    // 严格验证：只接收属于当前房间的进度更新
    if (progressPickupCode && progressPickupCode !== pickupCode) {
        console.log(`[房间隔离] 忽略不属于当前房间的进度: ${progressPickupCode} (当前: ${pickupCode})`);
        return;
    }
    
    if (progress !== undefined) {
        updateProgress(progress);
    }
    
    // 使用服务器报告的实际字节数计算准确的传输速度
    if (bytesTransferred !== undefined && transferStartTime) {
        const elapsed = (Date.now() - transferStartTime) / 1000;
        if (elapsed > 0) {
            const speed = bytesTransferred / elapsed;
            transferSpeed.textContent = `${formatFileSize(speed)}/s`;
        }
    }
}

function handleTransferSpeed(data) {
    const { pickupCode: speedPickupCode, speed } = data;
    
    // 严格验证：只接收属于当前房间的速度更新
    if (speedPickupCode && speedPickupCode !== pickupCode) {
        console.log(`[房间隔离] 忽略不属于当前房间的速度: ${speedPickupCode} (当前: ${pickupCode})`);
        return;
    }
    
    if (speed !== undefined) {
        transferSpeed.textContent = `${formatFileSize(speed)}/s`;
    }
}

function handleReceiverDisconnected(data) {
    const { pickupCode: disconnectedPickupCode } = data || {};
    
    // 验证是否属于当前房间
    if (disconnectedPickupCode && disconnectedPickupCode !== pickupCode) {
        console.log(`[房间隔离] 忽略不属于当前房间的断连通知: ${disconnectedPickupCode} (当前: ${pickupCode})`);
        return;
    }
    
    console.log(`[${pickupCode}] 接收端已断开连接，停止传输`);
    isTransferring = false;
    statusText.textContent = '接收端已断开连接';
    statusIndicator.style.background = '#dc3545';
    transferSpeed.textContent = '0 B/s';
    
    // 显示错误或重新等待连接
    setTimeout(() => {
        statusText.textContent = '等待接收方连接...';
        statusIndicator.style.background = '#ffc107';
    }, 3000);
}

function handleChunkAck(data) {
    if (data.pickupCode === pickupCode) {
        lastAckedChunk = data.chunkIndex;
        console.log(`[${pickupCode}] ACK chunk ${data.chunkIndex}`);
        
        // 收到确认，如果还有下一块，继续发送
        if (currentChunk < totalChunks) {
            readNextChunk();
        }
    }
}

// 开始文件传输
function startFileTransfer() {
    if (!selectedFile || !pickupCode) return;
    
    showStage('transfer-stage');
    transferStartTime = Date.now();
    isTransferring = true;
    
    // 增加分块大小到 1MB，提高大文件传输效率
    const chunkSize = 1024 * 1024; // 1MB chunks
    totalChunks = Math.ceil(selectedFile.size / chunkSize);
    currentChunk = 0;
    lastAckedChunk = -1; // 最后确认的chunk索引
    
    const reader = new FileReader();
    
    function readNextChunk() {
        if (!isTransferring) {
            console.log(`[${pickupCode}] 传输已停止`);
            return;
        }
        
        const start = currentChunk * chunkSize;
        const end = Math.min(start + chunkSize, selectedFile.size);
        const chunk = selectedFile.slice(start, end);
        
        reader.readAsArrayBuffer(chunk);
    }
    
    reader.onload = function(e) {
        if (!isTransferring) {
            console.log(`[${pickupCode}] 传输已停止，忽略读取结果`);
            return;
        }
        
        const chunkData = e.target.result;
        const isLast = currentChunk === totalChunks - 1;
        const chunkIndex = currentChunk;
        
        // 发送数据块
        socket.send(JSON.stringify({
            type: 'file-chunk',
            data: {
                pickupCode: pickupCode,
                chunk: Array.from(new Uint8Array(chunkData)), // 转换为数组以便JSON序列化
                chunkIndex: chunkIndex,
                totalChunks: totalChunks,
                isLast: isLast
            }
        }));
        
        console.log(`[${pickupCode}] 发送 chunk ${chunkIndex}/${totalChunks - 1}`);
        
        // 移动到下一个 chunk（等待 ACK）
        currentChunk++;
        
        // 如果是最后一块，也需要等待ACK确认数据被写入
        if (isLast) {
             console.log(`[${pickupCode}] 最后一块已发送，等待确认`);
        }
    };
    
    reader.onerror = function() {
        alert('文件读取失败');
        isTransferring = false;
    };
    
    // 开始读取第一个chunk
    readNextChunk();
}

// 更新传输进度
function updateProgress(progress) {
    const percent = Math.round(progress);
    progressFill.style.width = `${percent}%`;
    progressPercent.textContent = `${percent}%`;
    
    // 速度现在由接收端报告，本地不再计算
}

// 显示指定阶段
function showStage(stageId) {
    // 隐藏所有阶段
    document.querySelectorAll('.stage').forEach(stage => {
        stage.classList.remove('active');
    });
    
    // 显示目标阶段
    document.getElementById(stageId).classList.add('active');
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 全局变量 - 传输相关
let totalChunks = 0;
let currentChunk = 0;
let lastAckedChunk = -1;

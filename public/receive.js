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
      if (data.type === 'file-info') {
        handleFileInfo(data.data);
      } else if (data.type === 'transfer-progress') {
        handleTransferProgress(data.data);
      } else if (data.type === 'connection-lost') {
        handleConnectionLost(data.data);
      } else if (data.type === 'error') {
        handleError(data.data);
      } else if (data.type === 'session-joined') {
        // 处理加入会话的响应
        handleSessionJoined(data.data);
      }
    } catch (error) {
      console.error('解析WebSocket消息错误:', error);
    }
  };
}

// 初始化WebSocket连接
connectWebSocket();

// 全局变量
let currentPickupCode = null;
let receivedChunks = [];
let expectedFileInfo = null;
let downloadStartTime = null;
let totalBytesReceived = 0;
let isConnecting = false;
let isDownloading = false;
let totalChunks = 0;
let chunksReceived = 0;
let chunkMap = new Map(); // 用于存储接收到的chunk，按索引排序
let connectTimeout = null; // 连接超时定时器

// DOM 元素
const pickupCodeInput = document.getElementById('pickupCodeInput');
const connectBtn = document.getElementById('connectBtn');
const previewFileName = document.getElementById('previewFileName');
const previewFileSize = document.getElementById('previewFileSize');
const previewFileType = document.getElementById('previewFileType');
const downloadProgressFill = document.getElementById('downloadProgressFill');
const downloadProgressPercent = document.getElementById('downloadProgressPercent');
const downloadSpeed = document.getElementById('downloadSpeed');
const downloadFileName = document.getElementById('downloadFileName');
const errorText = document.getElementById('errorText');

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    setupInputHandlers();
});

// 设置输入处理
function setupInputHandlers() {
    const boxes = document.querySelectorAll('.code-box');
    
    // 更新UI显示函数
    function updateDisplay(value) {
        boxes.forEach((box, index) => {
            const char = value[index] || '';
            box.textContent = char;
            
            // 处理填充状态
            if (char) {
                box.classList.add('filled');
                // 只有新输入的字符才加动画（简单判断：如果是当前输入的最后一位）
                if (index === value.length - 1) {
                    box.classList.add('pop');
                    setTimeout(() => box.classList.remove('pop'), 300);
                }
            } else {
                box.classList.remove('filled');
            }
            
            // 处理激活聚焦状态
            // 如果当前是待输入位，或者是已满时的最后一位，则激活
            if (index === value.length || (value.length === 6 && index === 5)) {
                box.classList.add('active');
            } else {
                box.classList.remove('active');
            }
        });
    }

    // 取件码输入格式化
    pickupCodeInput.addEventListener('input', function(e) {
        let value = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
        if (value.length > 6) {
            value = value.slice(0, 6);
        }
        e.target.value = value;
        
        // 更新视觉UI
        updateDisplay(value);
        
        // 自动连接当输入6位时
        if (value.length === 6) {
            setTimeout(() => {
                // 检查是否已经在连接或连接成功
                if (!isConnecting && !currentPickupCode) {
                    connectToSender();
                }
            }, 500);
        }
    });
    
    // 聚焦处理
    pickupCodeInput.addEventListener('focus', () => {
        updateDisplay(pickupCodeInput.value);
    });
    
    pickupCodeInput.addEventListener('blur', () => {
        boxes.forEach(box => box.classList.remove('active'));
    });
    
    // 回车键连接
    pickupCodeInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && e.target.value.length === 6) {
            connectToSender();
        }
    });
    
    // 焦点到输入框
    pickupCodeInput.focus();
}

// 处理加入会话的响应
function handleSessionJoined(data) {
    isConnecting = false;
    
    if (data.success) {
        // 连接成功，取消超时检查
        clearTimeout(connectTimeout);
        
        // 更新连接按钮状态
        connectBtn.disabled = true;
        connectBtn.textContent = '已连接';
        
        // 等待文件信息
        // 文件信息将通过 'file-info' 消息接收
    } else {
        // 连接失败
        currentPickupCode = null;
        connectBtn.disabled = false;
        connectBtn.textContent = '连接';
        
        // 显示错误信息
        showError(data.message || '取件码无效或已过期');
    }
}

// 连接到发送方
function connectToSender() {
    const code = pickupCodeInput.value.trim();
    
    if (code.length !== 6) {
        alert('请输入6位取件码');
        return;
    }
    
    // 防止重复连接
    if (isConnecting) {
        console.log('正在连接中，忽略重复请求');
        return;
    }
    
    isConnecting = true;
    currentPickupCode = code;
    connectBtn.disabled = true;
    connectBtn.textContent = '连接中...';
    
    // 切换到连接中状态
    showStage('connecting-stage');
    
    // 设置连接超时
    connectTimeout = setTimeout(() => {
        if (isConnecting) {
            isConnecting = false;
            currentPickupCode = null;
            connectBtn.disabled = false;
            connectBtn.textContent = '连接';
            showError('连接超时，请检查网络连接或取件码是否正确');
        }
    }, 5000);
    
    // 尝试加入会话
    socket.send(JSON.stringify({
        type: 'join-session',
        data: { pickupCode: code }
    }));
}

// WebSocket事件处理函数
function handleFileInfo(data) {
    const { pickupCode: infoPickupCode, fileInfo } = data;
    
    // 严格验证：只接收属于当前房间的文件信息
    if (infoPickupCode && infoPickupCode !== currentPickupCode) {
        console.log(`[房间隔离] 忽略不属于当前房间的文件信息: ${infoPickupCode} (当前: ${currentPickupCode})`);
        return;
    }
    
    expectedFileInfo = fileInfo;
    
    // 显示文件预览
    previewFileName.textContent = fileInfo.name;
    previewFileSize.textContent = formatFileSize(fileInfo.size);
    previewFileType.textContent = fileInfo.type || '未知类型';
    
    // 切换到确认阶段
    showStage('file-confirm-stage');
}

function handleTransferProgress(data) {
    const { pickupCode: progressPickupCode, progress, chunkIndex, totalChunks: progressTotalChunks, bytesTransferred } = data;
    
    // 严格验证：只接收属于当前房间的进度更新
    if (progressPickupCode && progressPickupCode !== currentPickupCode) {
        console.log(`[房间隔离] 忽略不属于当前房间的进度: ${progressPickupCode} (当前: ${currentPickupCode})`);
        return;
    }
    
    // 更新本地变量用于速度计算
    if (progressTotalChunks) {
         totalChunks = progressTotalChunks;
    }
    
    // 使用服务器报告的实际字节数（更准确）
    if (bytesTransferred !== undefined && bytesTransferred > totalBytesReceived) {
        totalBytesReceived = bytesTransferred;
    }
    
    // 使用服务器同步的进度（更准确）
    if (progress !== undefined) {
        updateDownloadProgress(progress);
        
        // 如果进度达到100%，且没有在下载完成阶段，则切换状态
        if (progress >= 100 && isDownloading) {
            setTimeout(() => {
                showStage('download-complete-stage');
                isDownloading = false;
                // 通知服务器下载完成（虽然服务器可能已经知道了，但作为确认）
                socket.send(JSON.stringify({
                    type: 'download-complete',
                    data: { pickupCode: currentPickupCode }
                }));
            }, 1000);
        }
    }
}

function handleConnectionLost(data) {
    const { pickupCode: lostPickupCode } = data || {};
    
    // 验证是否属于当前房间
    if (lostPickupCode && lostPickupCode !== currentPickupCode) {
        console.log(`[房间隔离] 忽略不属于当前房间的断连: ${lostPickupCode} (当前: ${currentPickupCode})`);
        return;
    }
    
    console.log(`[${currentPickupCode}] 检测到连接丢失`);
    isDownloading = false;
    showError('连接已断开');
}

function handleError(message) {
    showError(message);
}

// 接受文件传输
function acceptTransfer() {
    if (!expectedFileInfo) return;
    
    // 更新下载文件名显示
    downloadFileName.textContent = expectedFileInfo.name;
    
    // 切换到下载阶段
    showStage('download-stage');
    
    // 构造下载链接
    const downloadUrl = `/api/download/${currentPickupCode}`;
    
    // 使用 iframe 触发下载
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = downloadUrl;
    document.body.appendChild(iframe);
    
    // 几分钟后清理 iframe
    setTimeout(() => {
        document.body.removeChild(iframe);
    }, 60000);
    
    console.log(`[${currentPickupCode}] 已发起HTTP流式下载请求`);
    
    // 重置进度条
    updateDownloadProgress(0);
    isDownloading = true;
    downloadStartTime = Date.now();
    totalBytesReceived = 0;
    
    // 通知服务器开始传输
    socket.send(JSON.stringify({
        type: 'start-transfer',
        data: { pickupCode: currentPickupCode }
    }));
}

// 拒绝文件传输
function declineTransfer() {
    socket.disconnect();
    location.reload();
}

// 完成下载
function completeDownload() {
    if (!expectedFileInfo) {
        showError('文件接收失败：缺少文件信息');
        return;
    }
    
    // 确定使用哪种存储方式
    const hasChunkMap = chunkMap.size > 0;
    const hasChunkArray = receivedChunks.length > 0;
    
    if (!hasChunkMap && !hasChunkArray) {
        showError('文件接收失败：没有接收到任何数据');
        return;
    }
    
    try {
        let mergedArray;
        let totalSize;
        
        if (hasChunkMap) {
            // 使用Map方式：按索引排序合并
            console.log(`[${currentPickupCode}] 使用Map方式合并 ${chunkMap.size} 个chunk`);
            totalSize = Array.from(chunkMap.values()).reduce((sum, chunk) => sum + chunk.length, 0);
            mergedArray = new Uint8Array(totalSize);
            let offset = 0;
            
            // 按索引顺序合并
            const sortedIndices = Array.from(chunkMap.keys()).sort((a, b) => a - b);
            for (const index of sortedIndices) {
                const chunk = chunkMap.get(index);
                mergedArray.set(chunk, offset);
                offset += chunk.length;
            }
        } else {
            // 使用数组方式：顺序合并
            console.log(`[${currentPickupCode}] 使用数组方式合并 ${receivedChunks.length} 个chunk`);
            totalSize = receivedChunks.reduce((sum, chunk) => sum + chunk.length, 0);
            mergedArray = new Uint8Array(totalSize);
            let offset = 0;
            
            for (const chunk of receivedChunks) {
                mergedArray.set(chunk, offset);
                offset += chunk.length;
            }
        }
        
        // 创建Blob并下载
        const blob = new Blob([mergedArray], { 
            type: expectedFileInfo.type || 'application/octet-stream' 
        });
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = expectedFileInfo.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        // 显示完成状态
        showStage('download-complete-stage');
        
        // 通知服务器和发送端下载完成
        socket.emit('download-complete', { pickupCode: currentPickupCode });
        console.log('文件下载完成，已通知发送端');
        
        // 清理数据和状态
        receivedChunks = [];
        chunkMap.clear();
        totalBytesReceived = 0;
        chunksReceived = 0;
        totalChunks = 0;
        isDownloading = false;
        
    } catch (error) {
        console.error('文件下载失败:', error);
        showError('文件下载失败');
    }
}

// 更新下载进度
function updateDownloadProgress(progress) {
    if (!isDownloading) {
        console.log('未在下载状态，不更新进度');
        return;
    }
    
    const percent = Math.round(Math.min(progress, 100));
    downloadProgressFill.style.width = `${percent}%`;
    downloadProgressPercent.textContent = `${percent}%`;
    
    // 计算下载速度
    if (downloadStartTime && totalBytesReceived > 0) {
        const elapsed = (Date.now() - downloadStartTime) / 1000;
        const speed = totalBytesReceived / elapsed;
        downloadSpeed.textContent = `${formatFileSize(speed)}/s`;
        
        // 定期向发送端发送速度更新（每秒发送一次，避免过于频繁）
        if (!window.lastSpeedUpdate || Date.now() - window.lastSpeedUpdate > 1000) {
            window.lastSpeedUpdate = Date.now();
            if (currentPickupCode && socket.connected) {
                socket.emit('transfer-speed', { 
                    pickupCode: currentPickupCode,
                    speed: speed
                });
            }
        }
    }
}

// 显示错误
function showError(message) {
    errorText.textContent = message;
    showStage('error-stage');
    
    // 重置所有状态
    isConnecting = false;
    isDownloading = false;
    currentPickupCode = null;
    connectBtn.disabled = false;
    connectBtn.textContent = '连接';
    
    // 清理数据
    receivedChunks = [];
    chunkMap.clear();
    totalBytesReceived = 0;
    chunksReceived = 0;
    totalChunks = 0;
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


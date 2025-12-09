const WebSocket = require('ws');

// 测试WebSocket连接和取件码功能
async function testWebSocket() {
  console.log('开始测试WebSocket连接...');
  
  try {
    // 1. 测试创建会话
    const sender = new WebSocket('ws://127.0.0.1:8787/ws');
    
    sender.on('open', () => {
      console.log('✓ 发送方连接成功');
      sender.send(JSON.stringify({ type: 'create-session' }));
    });
    
    sender.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        console.log('发送方收到消息:', JSON.stringify(message, null, 2));
        
        if (message.type === 'create-session-response') {
          if (message.data.success) {
            const pickupCode = message.data.pickupCode;
            console.log(`✓ 成功创建会话，取件码: ${pickupCode}`);
            
            // 发送文件信息
            setTimeout(() => {
              console.log('发送方发送文件信息...');
              sender.send(JSON.stringify({
                type: 'file-info',
                data: {
                  pickupCode: pickupCode,
                  fileInfo: {
                    name: 'test.txt',
                    size: 1024,
                    type: 'text/plain'
                  }
                }
              }));
              
              // 2. 测试加入会话
              testJoinSession(pickupCode, sender);
            }, 500);
          } else {
            console.error('✗ 创建会话失败:', message.data.message);
            sender.close();
          }
        }
      } catch (error) {
        console.error('✗ 解析消息错误:', error);
        console.error('原始消息:', data);
      }
    });
    
    sender.on('error', (error) => {
      console.error('✗ 发送方连接错误:', error);
    });
    
    sender.on('close', (code, reason) => {
      console.log(`发送方连接关闭: 代码 ${code}, 原因: ${reason}`);
    });
    
    // 设置超时，防止测试无限等待
    setTimeout(() => {
      if (sender.readyState === WebSocket.OPEN) {
        console.log('测试超时，关闭连接');
        sender.close();
      }
    }, 10000);
    
  } catch (error) {
    console.error('✗ 测试初始化失败:', error);
  }
}

// 测试加入会话
function testJoinSession(pickupCode, sender) {
  console.log('\n开始测试加入会话...');
  
  try {
    const receiver = new WebSocket('ws://127.0.0.1:8787/ws');
    
    receiver.on('open', () => {
      console.log('✓ 接收方连接成功');
      receiver.send(JSON.stringify({ 
        type: 'join-session', 
        data: { pickupCode: pickupCode } 
      }));
    });
    
    receiver.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        console.log('接收方收到消息:', JSON.stringify(message, null, 2));
        
        if (message.type === 'session-joined') {
          if (message.data.success) {
            console.log('✓ 成功加入会话');
          } else {
            console.error('✗ 加入会话失败:', message.data.message);
            receiver.close();
            sender.close();
            process.exit(1); // 错误退出
          }
        } else if (message.type === 'file-info') {
          console.log('✓ 接收方收到文件信息:', JSON.stringify(message.data.fileInfo, null, 2));
          
          // 测试完成，关闭所有连接
          setTimeout(() => {
            console.log('\n测试完成，关闭所有连接');
            receiver.close();
            sender.close();
            process.exit(0); // 正常退出
          }, 500);
        }
      } catch (error) {
        console.error('✗ 解析消息错误:', error);
        console.error('原始消息:', data);
        receiver.close();
        sender.close();
      }
    });
    
    receiver.on('error', (error) => {
      console.error('✗ 接收方连接错误:', error);
      receiver.close();
      sender.close();
    });
    
    receiver.on('close', (code, reason) => {
      console.log(`接收方连接关闭: 代码 ${code}, 原因: ${reason}`);
    });
    
    // 设置超时
    setTimeout(() => {
      if (receiver.readyState === WebSocket.OPEN) {
        console.log('测试超时，关闭接收方连接');
        receiver.close();
        sender.close();
      }
    }, 10000);
    
  } catch (error) {
    console.error('✗ 加入会话测试失败:', error);
    sender.close();
  }
}

// 运行测试
testWebSocket();
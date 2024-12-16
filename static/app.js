// static/app.js
let ws = null;
let mediaStream = null;
let audioContext = null;
let isConversationStarted = false;

// 添加音频队列管理
const audioQueue = [];
let isPlayingAudio = false;

// 添加音频缓冲区管理
const BUFFER_SIZE = 2048;  // 更大的缓冲区
const audioBuffers = [];
let isProcessingAudio = false;

const MIN_BUFFER_SIZE = 4800;    // 降低最小缓冲区大小
const MAX_BUFFER_SIZE = 32768;   // 保持最大缓冲区不变
const OPTIMAL_BUFFER_SIZE = 24576;  // 保持理想大小不变

const FRAME_CAPTURE_INTERVAL = 2000; // 捕获1帧间隔时间

async function processAudioBuffers() {
    if (isProcessingAudio || audioBuffers.length === 0) {
        return;
    }
    
    isProcessingAudio = true;
    
    try {
        // 计算当前可用的总数据量
        const totalAvailable = audioBuffers.reduce((acc, buf) => acc + buf.length, 0);
        
        // 确定这次处理的目标大小
        let targetSize;
        if (totalAvailable < MIN_BUFFER_SIZE) {
            // 即使数据较少也进行处理
            targetSize = totalAvailable;
        } else if (totalAvailable <= OPTIMAL_BUFFER_SIZE) {
            // 使用所有可用数据
            targetSize = totalAvailable;
        } else {
            // 使用理想大小或最大大小
            targetSize = Math.min(OPTIMAL_BUFFER_SIZE, MAX_BUFFER_SIZE);
        }
        
        const combinedBuffer = new Int16Array(targetSize);
        let offset = 0;
        
        // 填充缓冲区
        while (audioBuffers.length > 0 && offset < targetSize) {
            const buffer = audioBuffers[0];
            const remainingSpace = targetSize - offset;
            
            if (buffer.length <= remainingSpace) {
                combinedBuffer.set(buffer, offset);
                offset += buffer.length;
                audioBuffers.shift();
            } else {
                combinedBuffer.set(buffer.slice(0, remainingSpace), offset);
                audioBuffers[0] = buffer.slice(remainingSpace);
                offset += remainingSpace;
            }
        }
        
        // 创建新的AudioContext用于播放
        const playbackContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 24000
        });
        
        // 创建AudioBuffer
        const audioBuffer = playbackContext.createBuffer(1, offset, 24000);
        const channelData = audioBuffer.getChannelData(0);
        
        // 直接转换数据
        for (let i = 0; i < offset; i++) {
            channelData[i] = combinedBuffer[i] / 32768.0;
        }
        
        const source = playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        
        const gainNode = playbackContext.createGain();
        gainNode.gain.value = 0.8;
        
        source.connect(gainNode);
        gainNode.connect(playbackContext.destination);
        
        source.onended = () => {
            playbackContext.close();
            isProcessingAudio = false;
            if (audioBuffers.length > 0) {
                processAudioBuffers();
            }
        };
        
        console.log('Playing audio buffer, length:', offset);
        source.start(0);
        
    } catch (err) {
        console.error('Error processing audio:', err);
        isProcessingAudio = false;
        if (audioBuffers.length > 0) {
            processAudioBuffers();
        }
    }
}

async function playNextAudio() {
    if (isPlayingAudio || audioQueue.length === 0) {
        return;
    }
    
    isPlayingAudio = true;
    const base64Data = audioQueue.shift();
    
    try {
        // 将base64转换为原始PCM数据
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        // 创建AudioContext（如果还没有创建）
        const playbackContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 24000  // 接收采样率为24kHz
        });
        
        // 创建AudioBuffer
        const audioBuffer = playbackContext.createBuffer(1, bytes.length / 2, 24000);
        const channelData = audioBuffer.getChannelData(0);
        
        // 将16位PCM数据转换为Float32
        const int16View = new Int16Array(bytes.buffer);
        for (let i = 0; i < int16View.length; i++) {
            channelData[i] = int16View[i] / 32768.0;  // 转换为-1到1之间的浮点数
        }
        
        // 创建音源
        const source = playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        
        // 添加音量控制
        const gainNode = playbackContext.createGain();
        gainNode.gain.value = 0.8; // 降低音量以减少噪音
        
        // 连接节点
        source.connect(gainNode);
        gainNode.connect(playbackContext.destination);
        
        // 监听播放结束
        source.onended = () => {
            isPlayingAudio = false;
            playbackContext.close();
            playNextAudio(); // 播放下一段
        };
        
        console.log('Starting audio playback, buffer size:', bytes.length);
        source.start(0);
        
    } catch (err) {
        console.error('Error playing audio:', err);
        console.error('Error details:', {
            queueLength: audioQueue.length,
            dataLength: base64Data?.length
        });
        isPlayingAudio = false;
        playNextAudio(); // 出错时尝试播放下一段
    }
}

// 初始化 WebSocket 连接
function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    
    ws.onopen = () => {
        console.log('WebSocket connected');
        appendMessage('System', '连接成功');
    };
    
    ws.onclose = () => {
        console.log('WebSocket disconnected');
        appendMessage('System', '连接已断开');
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        appendMessage('System', '连接错误');
    };
    
    ws.onmessage = function(event) {
        const data = JSON.parse(event.data);
        
        if (data.type === "text") {
            // 显示文本消息
            appendMessage("AI", data.content);
        } else if (data.type === "audio") {
            // 播放音频
            playAudio(data.content);
        }
    };
}

// 获取用户媒体流
async function startMedia() {
    try {
        // 更严格的音频约束
        mediaStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 16000,
                latency: 0,
                echoCancellationType: 'system',  // 使用系统级回音消除
                suppressLocalAudioPlayback: true  // 禁止本地音频回放
            }
        });
        
        document.getElementById('localVideo').srcObject = mediaStream;
        
        // 创建音频上下文
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000,
            latencyHint: 'interactive'  // 降低延迟
        });
        await audioContext.resume();
        
        startSendingMedia();
        
    } catch (err) {
        console.error("Error accessing media devices:", err);
        appendMessage('System', '设备访问失败,请检查权限设置');
    }
}

// 发送音视频数据
function startSendingMedia() {
    if (!audioContext) {
        console.error('AudioContext not initialized');
        return;
    }
    
    try {
        // 音频处理
        const source = audioContext.createMediaStreamSource(mediaStream);
        const processor = audioContext.createScriptProcessor(512, 1, 1);
        
        // 创建静音节点
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0;  // 设置增益为0，实现静音
        
        // 静音检测相关变量
        let silenceStart = null;
        const SILENCE_THRESHOLD = 0.01;
        const SILENCE_DURATION = 1000;
        
        processor.onaudioprocess = (e) => {
            if (!isPlayingAudio) {  // 只在不播放时发送音频
                const inputData = e.inputBuffer.getChannelData(0);
                
                // 计算音量级别
                let volume = 0;
                for (let i = 0; i < inputData.length; i++) {
                    volume += Math.abs(inputData[i]);
                }
                volume = volume / inputData.length;
                
                // 静音检测
                if (volume < SILENCE_THRESHOLD) {
                    if (silenceStart === null) {
                        silenceStart = Date.now();
                    } else if (Date.now() - silenceStart >= SILENCE_DURATION) {
                        // 发送结束标记
                        ws.send(JSON.stringify({
                            type: "turn_complete"
                        }));
                        silenceStart = null;
                    }
                } else {
                    silenceStart = null;
                }
                
                const pcmData = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
                }
                
                const base64data = btoa(String.fromCharCode(...new Uint8Array(pcmData.buffer)));
                
                ws.send(JSON.stringify({
                    mime_type: "audio/pcm",
                    content: base64data
                }));
            }
        };
        
        // 建立处理链，但使用静音输出
        source.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(audioContext.destination);  // 需要连接到destination以保持处理器工作
        
        // 断开本地视频的音频轨道
        const videoElement = document.getElementById('localVideo');
        videoElement.muted = true;  // 静音本地视频
        
        console.log('Audio processing started (with silent output)');
        
        // 视频处理部分
        let lastFrameTime = 0;
        const videoTrack = mediaStream.getVideoTracks()[0];
        
        async function captureAndSendFrame() {
            const currentTime = Date.now();
            
            if (currentTime - lastFrameTime >= FRAME_CAPTURE_INTERVAL) {
                try {
                    const video = document.getElementById('localVideo');
                    const canvas = document.createElement('canvas');
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(video, 0, 0);
                    
                    const base64data = canvas.toDataURL('image/jpeg').split(',')[1];
                    
                    ws.send(JSON.stringify({
                        mime_type: "image/jpeg",
                        content: base64data
                    }));
                    
                    lastFrameTime = currentTime;
                    
                } catch (err) {
                    console.error('Error capturing video frame:', err);
                }
            }
            
            requestAnimationFrame(captureAndSendFrame);
        }
        
        captureAndSendFrame();
        
    } catch (err) {
        console.error("Error in startSendingMedia:", err);
    }
}

// 播放音频
function playAudio(base64Data) {
    try {
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        
        // 将数据添加到缓冲区
        const int16Data = new Int16Array(bytes.buffer);
        audioBuffers.push(int16Data);
        
        // 触发处理
        processAudioBuffers();
        
    } catch (err) {
        console.error('Error queuing audio:', err);
    }
}

// 发送文本消息
function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    
    if (message) {
        ws.send(JSON.stringify({
            type: "text",
            content: message
        }));
        
        appendMessage("You", message);
        input.value = '';
    }
}

// 显示消息
function appendMessage(sender, text) {
    const messages = document.getElementById('messages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender.toLowerCase()}`;
    messageDiv.innerHTML = `<strong>${sender}:</strong> ${text}`;
    messages.appendChild(messageDiv);
    messages.scrollTop = messages.scrollHeight;
}

// 事件监听
document.getElementById('startButton').onclick = async () => {
    connectWebSocket();
    await startMedia();
};

document.getElementById('stopButton').onclick = () => {
    if (ws) ws.close();
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }
};

document.getElementById('messageInput').onkeydown = (e) => {
    if (e.key === 'Enter') sendMessage();
};

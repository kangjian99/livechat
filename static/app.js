// static/app.js
let ws = null;
let mediaStream = null;
let audioContext = null;
let isConversationStarted = false;

// 采样率常量
const SEND_SAMPLE_RATE = 16000;  // 发送采样率
const RECEIVE_SAMPLE_RATE = 24000;  // 接收采样率
const CHUNK_SIZE = 512;  // 与Python端保持一致

// 全局音频上下文
let globalAudioContext = null;
let isPlayingAudio = false;
const audioQueue = [];

const FRAME_CAPTURE_INTERVAL = 2000; // 捕获1帧间隔时间
const AUTO_CLOSE_MINUTES = 5;  // 自动断连时间

let currentFacingMode = "environment"; // 默认使用后置摄像头

function getDeviceType() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "mobile" : "desktop";
}

// 初始化全局音频上下文
function initAudioContext() {
    if (!globalAudioContext) {
        globalAudioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: RECEIVE_SAMPLE_RATE
        });
    }
    return globalAudioContext;
}

// 音频处理函数
async function processAudio(audioData) {
    if (isPlayingAudio) {
        audioQueue.push(audioData);
        return;
    }
    
    isPlayingAudio = true;
    
    try {
        const context = initAudioContext();
        
        const audioBuffer = context.createBuffer(1, audioData.length, RECEIVE_SAMPLE_RATE);
        const channelData = audioBuffer.getChannelData(0);
        
        for (let i = 0; i < audioData.length; i++) {
            channelData[i] = audioData[i] / 32768.0;
        }
        
        const source = context.createBufferSource();
        source.buffer = audioBuffer;
        
        // 添加音量控制
        const gainNode = context.createGain();
        gainNode.gain.value = 1.0; // 可以调整音量
        
        source.connect(gainNode);
        gainNode.connect(context.destination);
        
        source.onended = () => {
            isPlayingAudio = false;
            if (audioQueue.length > 0) {
                processAudio(audioQueue.shift());
            }
        };
        
        source.start(0);
        
    } catch (err) {
        console.error('Error playing audio:', err);
        isPlayingAudio = false;
        if (audioQueue.length > 0) {
            processAudio(audioQueue.shift());
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
            sampleRate: RECEIVE_SAMPLE_RATE
        });
        
        // 创建AudioBuffer
        const audioBuffer = playbackContext.createBuffer(1, bytes.length / 2, RECEIVE_SAMPLE_RATE);
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
    
    let timeoutId = null;
    
    ws.onopen = () => {
        console.log('WebSocket connected');
        appendMessage('System', '连接成功');
        
        // 设置x分钟后自动断开连接
        timeoutId = setTimeout(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                // 发送提示消息
                appendMessage('System', '连接即将在1分钟后自动断开，请确认继续使用。');
                // 再设置1分钟后断开连接
                setTimeout(() => {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.close();
                        console.log(`WebSocket closed after ${AUTO_CLOSE_MINUTES} minutes`);
                        appendMessage('System', `连接超过${AUTO_CLOSE_MINUTES}分钟，已自动断开`);
                    }
                }, 60000);
            }
        }, (AUTO_CLOSE_MINUTES - 1) * 60000); // 在超时前1分钟发送提示消息
    };
    
    ws.onclose = () => {
        console.log('WebSocket disconnected');
        appendMessage('System', '连接已断开');
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        appendMessage('System', '连接错误');
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
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

function getOptimalVideoSettings() {
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const aspectRatio = isMobile ? { width: { ideal: 800 }, height: { ideal: 600 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
    return {
        video: {
            facingMode: currentFacingMode,
            ...aspectRatio
        },
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: SEND_SAMPLE_RATE,  // 使用发送采样率常量
            latency: 0,
            suppressLocalAudioPlayback: true
        }
    };
}

// 获取用户媒体流
async function startMedia() {
    try {
        const mediaSettings = getOptimalVideoSettings();
        mediaStream = await navigator.mediaDevices.getUserMedia(mediaSettings);
        
        const videoElement = document.getElementById('localVideo');
        videoElement.srcObject = mediaStream;
        videoElement.muted = true;  // 静音本地视频
        
        // 创建音频上下文
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: SEND_SAMPLE_RATE,  // 使用发送采样率常量
            latencyHint: 'interactive'  // 降低延迟
        });
        await audioContext.resume();

        startSendingMedia();
        const deviceType = getDeviceType() === "mobile" ? "手机端" : "电脑端";
        appendMessage('System', `当前设备类型: ${deviceType}`);
        
    } catch (err) {
        console.error("Error accessing media devices:", err);
        appendMessage('System', '设备访问失败，请检查权限设置');
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
        
        const int16Data = new Int16Array(bytes.buffer);
        processAudio(int16Data);
        
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

// 添加切换摄像头的函数
async function switchCamera() {
    if (!mediaStream) {
        console.error('No media stream available');
        return;
    }

    try {
        // 停止当前视频流
        mediaStream.getVideoTracks().forEach(track => track.stop());
        
        // 切换摄像头
        currentFacingMode = currentFacingMode === "environment" ? "user" : "environment";
        
        // 重新获取媒体流
        await startMedia();
        
        // 更新UI显示当前使用的摄像头
        const cameraStatus = currentFacingMode === "environment" ? "后置" : "前置";
        appendMessage('System', `已切换至${cameraStatus}摄像头`);
        
    } catch (err) {
        console.error('切换摄像头失败:', err);
        appendMessage('System', '切换摄像头失败,请检查设备权限');
        
        // 切换失败时恢复之前的设置
        currentFacingMode = currentFacingMode === "environment" ? "user" : "environment";
    }
}

// 清理函数 - 在需要时调用
function cleanupAudio() {
    if (globalAudioContext) {
        globalAudioContext.close();
        globalAudioContext = null;
    }
    audioQueue.length = 0;
    isPlayingAudio = false;
}

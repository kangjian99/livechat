# main.py
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import asyncio
import json
import base64
from PIL import Image
import io
import time
from google import genai

MODEL = "models/gemini-2.0-flash-exp"
CONFIG = {"generation_config": {"response_modalities": ["AUDIO"]}}

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")

# HTML 模板
HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>AI 助手</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <link rel="stylesheet" href="/static/style.css">
</head>
<body>
    <div class="container">
        <div class="video-container">
            <video id="localVideo" autoplay playsinline></video>
        </div>
        
        <div class="chat-container">
            <div id="messages" class="messages"></div>
            <div class="input-container">
                <input type="text" id="messageInput" placeholder="输入消息...">
                <button onclick="sendMessage()">发送</button>
            </div>
        </div>
        
        <div class="controls">
            <button id="startButton">开始live对话</button>
            <button id="stopButton">结束对话</button>
            <div id="cameraButton"></div>
        </div>
    </div>
    <script src="/static/app.js"></script>
    <script>
        const deviceType = getDeviceType();
        if (deviceType !== 'desktop') {
            const cameraButton = document.getElementById('cameraButton');
            cameraButton.innerHTML = '<button id="switchCameraBtn" onclick="switchCamera()" style="font-size: 24px; background: none; border: none; cursor: pointer;">📷</button>';
        }
    </script>
</body>
</html>
"""

@app.get("/")
async def get():
    return HTMLResponse(HTML)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    print("New WebSocket connection request")
    await websocket.accept()
    
    try:
        # 初始化 genai client
        client = genai.Client(http_options={"api_version": "v1alpha"})
        
        async with client.aio.live.connect(model=MODEL, config=CONFIG) as session:
            print("Google AI session established")
            
            # 创建队列用于音视频数据传输
            audio_in_queue = asyncio.Queue()
            media_out_queue = asyncio.Queue(maxsize=5)
            
            async with asyncio.TaskGroup() as tg:
                # 处理来自客户端的消息
                client_task = tg.create_task(
                    handle_client_messages(websocket, session, media_out_queue)
                )
                
                # 发送媒体数据到 Google AI
                media_task = tg.create_task(
                    send_media_to_ai(session, media_out_queue)
                )
                
                # 处理 AI 响应
                ai_task = tg.create_task(
                    handle_ai_responses(websocket, session, audio_in_queue)
                )
                
                # 播放音频
                audio_task = tg.create_task(
                    play_audio(websocket, audio_in_queue)
                )
                
                def check_task(task):
                    if task.cancelled():
                        print(f"Task was cancelled: {task}")
                    if task.exception():
                        print(f"Task failed: {task.exception()}")
                
                for task in [client_task, media_task, ai_task, audio_task]:
                    task.add_done_callback(check_task)
                    
    except Exception as e:
        print(f"Session error: {e}")
    finally:
        print("Session closed")

async def handle_client_messages(websocket, session, media_queue):
    last_frame_time = 0
    
    while True:
        try:
            raw_message = await websocket.receive()
            
            if "text" in raw_message:
                data = json.loads(raw_message["text"])
                
                # 处理文本消息
                if "content" in data and not "mime_type" in data:
                    await session.send(data["content"], end_of_turn=True)
                
                # 处理媒体数据
                elif "mime_type" in data and "content" in data:
                    current_time = time.time()
                    
                    # 处理视频帧
                    if data["mime_type"].startswith("image/"):
                        if current_time - last_frame_time >= 1.0:
                            try:
                                img_data = base64.b64decode(data["content"])
                                img = Image.open(io.BytesIO(img_data))
                                img.thumbnail((1024, 1024))
                                
                                buffer = io.BytesIO()
                                img.save(buffer, format="jpeg")
                                
                                await media_queue.put({
                                    "mime_type": "image/jpeg",
                                    "data": base64.b64encode(buffer.getvalue()).decode()
                                })
                                
                                last_frame_time = current_time
                                
                            except Exception as e:
                                print(f"Error processing image: {e}")
                    
                    # 处理音频数据
                    elif data["mime_type"] == "audio/pcm":
                        try:
                            audio_data = base64.b64decode(data["content"])
                            await media_queue.put({
                                "mime_type": "audio/pcm",
                                "data": audio_data
                            })
                        except Exception as e:
                            print(f"Error processing audio: {e}")
                    
        except Exception as e:
            print(f"Error handling client message: {e}")
            raise

async def send_media_to_ai(session, media_queue):
    while True:
        msg = await media_queue.get()
        await session.send(msg)

async def handle_ai_responses(websocket, session, audio_queue):
    while True:
        turn = session.receive()
        async for response in turn:
            if data := response.data:
                await audio_queue.put(data)
            if text := response.text:
                await websocket.send_json({
                    "type": "text",
                    "content": text
                })
        
        # 清空音频队列以支持打断
        while not audio_queue.empty():
            audio_queue.get_nowait()

async def play_audio(websocket, audio_queue):
    while True:
        data = await audio_queue.get()
        await websocket.send_json({
            "type": "audio",
            "content": base64.b64encode(data).decode()
        })

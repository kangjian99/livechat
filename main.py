# main.py
from dotenv import load_dotenv
load_dotenv()
import uvicorn

from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import asyncio
import json
import base64
import os
from websockets.client import connect
from PIL import Image
import io
import time

app = FastAPI()

# 挂载静态文件目录
app.mount("/static", StaticFiles(directory="static"), name="static")

# HTML 模板
HTML = """
<!DOCTYPE html>
<html>
<head>
    <title>AI 助手</title>
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
            <button id="startButton">开始对话</button>
            <button id="stopButton">结束对话</button>
        </div>
    </div>
    <script src="/static/app.js"></script>
</body>
</html>
"""

@app.get("/")
async def get():
    return HTMLResponse(HTML)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    print("New WebSocket connection request")  # 调试日志
    await websocket.accept()
    print("WebSocket connection accepted")  # 调试日志
    
    try:
        google_ws = await connect_google_ai()
        print("Google AI connection established")  # 调试日志
        
        try:
            async with asyncio.TaskGroup() as tg:
                client_task = tg.create_task(handle_client_messages(websocket, google_ws))
                google_task = tg.create_task(handle_google_messages(websocket, google_ws))
                
                def check_task(task):
                    if task.cancelled():
                        print(f"Task was cancelled: {task}")
                        return
                    if task.exception():
                        print(f"Task failed: {task.exception()}")
                        print(f"Exception type: {type(task.exception())}")
                        
                client_task.add_done_callback(check_task)
                google_task.add_done_callback(check_task)
                
        except* Exception as e:
            print(f"TaskGroup error details:", e)
            for exc in e.exceptions:
                print(f"Exception type: {type(exc)}")
                print(f"Exception: {exc}")
    except Exception as e:
        print(f"Connection error: {e}")
    finally:
        if 'google_ws' in locals():
            await google_ws.close()
            print("Google AI connection closed")  # 调试日志

async def connect_google_ai():
    """连接到 Google AI 服务"""
    try:
        host = 'generativelanguage.googleapis.com'
        model = "gemini-2.0-flash-exp"
        api_key = os.environ['GOOGLE_API_KEY']
        uri = f"wss://{host}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key={api_key}"
        
        print(f"Connecting to {host}...")  # 调试日志
        
        ws = await connect(uri)
        print("WebSocket connected")  # 调试日志
        
        # 发送setup消息
        setup_msg = {
            "setup": {
                "model": f"models/{model}"
            }
        }
        print(f"Sending setup message: {setup_msg}")  # 调试日志
        await ws.send(json.dumps(setup_msg))
        
        # 等待setup响应
        setup_response = await ws.recv()
        print(f"Setup response received: {setup_response}")  # 调试日志
        
        return ws
        
    except Exception as e:
        print(f"Error connecting to Google AI: {e}")
        print(f"Error type: {type(e)}")
        raise

async def handle_client_messages(websocket: WebSocket, google_ws):
    last_frame_time = 0
    
    while True:
        try:
            raw_message = await websocket.receive()
            #print(f"Received raw message type: {raw_message.get('type', 'unknown')}")  # 调试日志
            
            if "text" in raw_message:
                data = json.loads(raw_message["text"])
                #print(f"Parsed client data: {data}")  # 调试日志
                
                # 处理文本消息
                if "content" in data and not "mime_type" in data:
                    msg = {
                        "client_content": {
                            "turn_complete": True,
                            "turns": [{"role": "user", "parts": [{"text": data["content"]}]}],
                        }
                    }
                    print(f"Sending text message to Google AI: {msg}")  # 调试日志
                    await google_ws.send(json.dumps(msg))
                
                # 处理媒体数据
                elif "mime_type" in data and "content" in data:
                    current_time = time.time()
                    
                    # 处理视频帧
                    if data["mime_type"].startswith("image/"):
                        if current_time - last_frame_time >= 1.0:
                            try:
                                img_data = base64.b64decode(data["content"])
                                img = Image.open(io.BytesIO(img_data))
                                
                                max_size = (1024, 1024)
                                img.thumbnail(max_size)
                                
                                buffer = io.BytesIO()
                                img.save(buffer, format="jpeg")
                                compressed_data = base64.b64encode(buffer.getvalue()).decode()
                                
                                msg = {
                                    "realtime_input": {
                                        "media_chunks": [
                                            {
                                                "data": compressed_data,
                                                "mime_type": "image/jpeg"
                                            }
                                        ]
                                    }
                                }
                                #print("Sending video frame to Google AI")  # 调试日志
                                await google_ws.send(json.dumps(msg))
                                last_frame_time = current_time
                                
                            except Exception as e:
                                print(f"Error processing image: {e}")
                    
                    # 处理音频数据
                    elif data["mime_type"] == "audio/pcm":
                        # 验证音频数据格式
                        try:
                            audio_data = base64.b64decode(data["content"])
                            #print(f"Received audio chunk size: {len(audio_data)} bytes")  # 调试日志
                            
                            # 确保音频数据大小符合预期
                            expected_size = 512 * 2  # 512 samples * 2 bytes per sample (16-bit)
                            if len(audio_data) != expected_size:
                                print(f"Warning: Unexpected audio chunk size. Expected {expected_size}, got {len(audio_data)}")
                            
                            msg = {
                                "realtime_input": {
                                    "media_chunks": [
                                        {
                                            "data": data["content"],
                                            "mime_type": "audio/pcm"
                                        }
                                    ]
                                }
                            }
                            #print("Sending audio chunk to Google AI")  # 调试日志
                            await google_ws.send(json.dumps(msg))
                            
                        except Exception as e:
                            print(f"Error processing audio: {e}")
                    
        except json.JSONDecodeError as e:
            print(f"Error decoding client message: {e}")
        except KeyError as e:
            print(f"KeyError in client message: {e}")
            print(f"Message structure: {raw_message}")
        except Exception as e:
            print(f"Unexpected error in client message handling: {e}")
            print(f"Error type: {type(e)}")
            raise

async def handle_google_messages(client_ws: WebSocket, google_ws):
    print("Starting to handle Google messages")  # 调试日志
    async for message in google_ws:
        #print(f"Received message from Google AI: {message}")  # 调试日志
        
        try:
            # 确保正确解码消息
            if isinstance(message, bytes):
                decoded_message = message.decode("ascii")
            else:
                decoded_message = message
                
            response = json.loads(decoded_message)
            #print(f"Parsed response: {response}")  # 调试日志
            
            # 处理文本响应
            if "serverContent" in response:
                if "modelTurn" in response["serverContent"]:
                    if "parts" in response["serverContent"]["modelTurn"]:
                        for part in response["serverContent"]["modelTurn"]["parts"]:
                            try:
                                if "text" in part:
                                    print(f"Sending text to client: {part['text']}")  # 调试日志
                                    await client_ws.send_json({
                                        "type": "text",
                                        "content": part["text"]
                                    })
                                elif "inlineData" in part and "data" in part["inlineData"]:
                                    #print("Sending audio data to client")  # 调试日志
                                    await client_ws.send_json({
                                        "type": "audio",
                                        "content": part["inlineData"]["data"]
                                    })
                            except Exception as e:
                                print(f"Error processing part: {e}")
                                print(f"Part content: {part}")
                
                if "turnComplete" in response["serverContent"]:
                    print("Turn complete")
                    
            elif "setupComplete" in response:
                print("Setup completed successfully")
                
        except json.JSONDecodeError as e:
            print(f"Error decoding JSON: {e}")
            print(f"Raw message: {message}")
        except KeyError as e:
            print(f"KeyError while parsing response: {e}")
            print(f"Response structure: {response}")
        except Exception as e:
            print(f"Unexpected error: {e}")
            print(f"Error type: {type(e)}")
            print(f"Full message: {message}")

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", reload=True, port=8000)
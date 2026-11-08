import os
import uvicorn

uvicorn.run("server.app:app", host=os.getenv("HOPMUX_BIND", "127.0.0.1"), port=int(os.getenv("HOPMUX_PORT", "8000")), proxy_headers=False)

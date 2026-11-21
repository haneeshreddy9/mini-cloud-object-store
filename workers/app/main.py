
import asyncio
import os
import re
from pathlib import Path
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse


WORKER_ID = os.getenv("WORKER_ID", "worker1")
WORKER_URL = os.getenv("WORKER_URL", "http://worker1:8001")

CONTROLLER_URL = os.getenv(
    "CONTROLLER_URL",
    "http://localhost:8000"
)

HEARTBEAT_INTERVAL = 10

STORAGE_DIR = Path("/data")
STORAGE_DIR.mkdir(parents=True, exist_ok=True)


async def communicate_with_controller():

    while True:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:

                registration = await client.post(
                    f"{CONTROLLER_URL}/internal/workers/register",
                    json={
                        "worker_id": WORKER_ID,
                        "base_url": WORKER_URL
                    }
                )

                registration.raise_for_status()

                print(f"[{WORKER_ID}] Registered successfully")

                while True:

                    response = await client.post(
                        f"{CONTROLLER_URL}/internal/workers/heartbeat",
                        json={"worker_id": WORKER_ID}
                    )

                    response.raise_for_status()

                    print(f"[{WORKER_ID}] Heartbeat sent")

                    await asyncio.sleep(HEARTBEAT_INTERVAL)

        except asyncio.CancelledError:
            raise

        except Exception as error:

            print(
                f"[{WORKER_ID}] Controller communication failed: {error}"
            )

            await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app: FastAPI):

    heartbeat_task = asyncio.create_task(
        communicate_with_controller()
    )

    yield

    heartbeat_task.cancel()

    try:
        await heartbeat_task
    except asyncio.CancelledError:
        pass


app = FastAPI(
    title=f"Cloud Object Store - {WORKER_ID}",
    version="1.0.0",
    lifespan=lifespan
)


def get_chunk_path(chunk_id: str) -> Path:

    if not re.fullmatch(r"[a-f0-9]{32}", chunk_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid chunk ID"
        )

    return STORAGE_DIR / f"{chunk_id}.chunk"


@app.get("/")
def root():

    return {
        "worker_id": WORKER_ID,
        "status": "running"
    }


@app.get("/health")
def health():

    return {
        "worker_id": WORKER_ID,
        "status": "healthy"
    }


@app.put("/internal/chunks/{chunk_id}")
async def store_chunk(chunk_id: str, request: Request):

    chunk_path = get_chunk_path(chunk_id)

    data = await request.body()

    if not data:
        raise HTTPException(
            status_code=400,
            detail="Empty chunk"
        )

    chunk_path.write_bytes(data)

    return {
        "message": "Chunk stored successfully",
        "worker_id": WORKER_ID,
        "chunk_id": chunk_id,
        "size": len(data)
    }


@app.get("/internal/chunks/{chunk_id}")
def retrieve_chunk(chunk_id: str):

    chunk_path = get_chunk_path(chunk_id)

    if not chunk_path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Chunk not found"
        )

    data = chunk_path.read_bytes()

    return Response(
        content=data,
        media_type="application/octet-stream"
    )


@app.delete("/internal/chunks/{chunk_id}")
def delete_chunk(chunk_id: str):

    chunk_path = get_chunk_path(chunk_id)

    if not chunk_path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Chunk not found"
        )

    chunk_path.unlink()

    return Response(status_code=204)


@app.get("/internal/workers/{worker_id}/chunks")
def list_chunks(worker_id: str):

    if worker_id != WORKER_ID:
        raise HTTPException(
            status_code=404,
            detail="Worker not found"
        )

    chunks = []

    for chunk_path in STORAGE_DIR.glob("*.chunk"):

        chunks.append({
            "chunk_id": chunk_path.stem,
            "size": chunk_path.stat().st_size
        })

    return {
        "worker_id": WORKER_ID,
        "total_chunks": len(chunks),
        "chunks": chunks
    }

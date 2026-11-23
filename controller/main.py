
import hashlib
import asyncio
import json
import sqlite3
import uuid

from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Dict

import httpx

from fastapi import FastAPI, Form, HTTPException, UploadFile, File
from fastapi.responses import Response
from pydantic import BaseModel


# ---------------- CONFIGURATION ----------------

app = FastAPI(
    title="Mini Cloud Object Store - Controller",
    description="Distributed object storage controller",
    version="1.0.0"
)

CHUNK_SIZE = 1024 * 1024

DATABASE_DIR = Path("/app/database")
DATABASE_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_PATH = DATABASE_DIR / "object_store.db"

workers: Dict[str, dict] = {}


# ---------------- DATABASE ----------------

@contextmanager
def database_connection():

    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row

    try:
        yield connection
        connection.commit()

    except Exception:
        connection.rollback()
        raise

    finally:
        connection.close()



def initialize_database():

    with database_connection() as conn:

        # Create objects table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS objects (
                object_id TEXT PRIMARY KEY,
                object_name TEXT NOT NULL,
                size INTEGER NOT NULL,
                content_type TEXT,
                checksum TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_modified TEXT NOT NULL,
                custom_metadata TEXT DEFAULT '{}'
            )
        """)

        # Create chunks table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS chunks (
                chunk_id TEXT PRIMARY KEY,
                object_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                size INTEGER NOT NULL,
                checksum TEXT NOT NULL,
                worker_id TEXT NOT NULL,
                worker_url TEXT NOT NULL,
                FOREIGN KEY (object_id)
                    REFERENCES objects(object_id)
                    ON DELETE CASCADE
            )
        """)

        # Check existing database columns
        columns = {
            row["name"]
            for row in conn.execute(
                "PRAGMA table_info(chunks)"
            ).fetchall()
        }

        # Add primary/replica tracking columns
        if "replica_worker_id" not in columns:
            conn.execute("""
                ALTER TABLE chunks
                ADD COLUMN replica_worker_id TEXT
            """)

        if "replica_worker_url" not in columns:
            conn.execute("""
                ALTER TABLE chunks
                ADD COLUMN replica_worker_url TEXT
            """)

        # Create indexes
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_chunks_object_id
            ON chunks(object_id)
        """)

        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_objects_created_at
            ON objects(created_at)
        """)


initialize_database()


# ---------------- MODELS ----------------

class WorkerRegistration(BaseModel):
    worker_id: str
    base_url: str


class WorkerHeartbeat(BaseModel):
    worker_id: str


class MetadataUpdate(BaseModel):
    metadata: dict[str, str]


# ---------------- HELPERS ----------------

def get_object(object_id: str):

    with database_connection() as conn:

        obj = conn.execute(
            "SELECT * FROM objects WHERE object_id = ?",
            (object_id,)
        ).fetchone()

        if obj is None:
            return None

        chunks = conn.execute(
            """
            SELECT * FROM chunks
            WHERE object_id = ?
            ORDER BY chunk_index
            """,
            (object_id,)
        ).fetchall()

        return {
            "object_id": obj["object_id"],
            "object_name": obj["object_name"],
            "size": obj["size"],
            "content_type": obj["content_type"],
            "checksum": obj["checksum"],
            "created_at": obj["created_at"],
            "last_modified": obj["last_modified"],
            "custom_metadata": json.loads(
                obj["custom_metadata"]
            ),
            "chunks": [dict(chunk) for chunk in chunks]
        }


def get_available_workers():

    current_time = datetime.now(timezone.utc)

    available = []

    for worker in workers.values():

        is_healthy = (
            current_time - worker["last_heartbeat"]
            < timedelta(seconds=30)
        )

        if is_healthy:
            available.append(worker)

    return available

# ---------------- AUTOMATIC REPLICA REPAIR ----------------

async def repair_missing_replicas():

    print("[REPAIR] Starting replica repair scan")

    with database_connection() as conn:
        chunks = conn.execute(
            """
            SELECT * FROM chunks
            ORDER BY object_id, chunk_index
            """
        ).fetchall()

    available_workers = get_available_workers()

    if not available_workers:
        print("[REPAIR] No healthy workers available")
        return

    async with httpx.AsyncClient(timeout=20.0) as client:

        for chunk_row in chunks:

            chunk = dict(chunk_row)

            chunk_id = chunk["chunk_id"]
            checksum = chunk["checksum"]

            primary = {
                "worker_id": chunk["worker_id"],
                "base_url": chunk["worker_url"]
            }

            replica = {
                "worker_id": chunk["replica_worker_id"],
                "base_url": chunk["replica_worker_url"]
            }

            # Check whether each copy is actually accessible
            valid_copies = []

            for location in [primary, replica]:

                if not location["base_url"]:
                    continue

                try:
                    response = await client.get(
                        f"{location['base_url']}/internal/chunks/{chunk_id}"
                    )

                    response.raise_for_status()

                    data = response.content

                    actual_checksum = hashlib.sha256(
                        data
                    ).hexdigest()

                    if actual_checksum == checksum:
                        valid_copies.append({
                            **location,
                            "data": data
                        })

                except httpx.HTTPError:
                    continue

            # Two valid copies: nothing to repair
            if len(valid_copies) == 2:
                continue

            # No valid copy: data cannot safely be reconstructed
            if len(valid_copies) == 0:
                print(
                    f"[REPAIR] WARNING: No valid copy found for {chunk_id}"
                )
                continue

            # Find a healthy Worker not already assigned this chunk
            existing_worker_ids = {
                primary["worker_id"],
                replica["worker_id"]
            }

            candidates = [
                worker for worker in available_workers
                if worker["worker_id"] not in existing_worker_ids
            ]

            if not candidates:
                print(
                    f"[REPAIR] No replacement Worker available for {chunk_id}"
                )
                continue

            source = valid_copies[0]
            replacement = candidates[0]

            # Upload the surviving data to the replacement Worker
            try:

                response = await client.put(
                    f"{replacement['base_url']}/internal/chunks/{chunk_id}",
                    content=source["data"],
                    headers={
                        "Content-Type": "application/octet-stream"
                    }
                )

                response.raise_for_status()

                # Verify the replacement by downloading it again
                verify_response = await client.get(
                    f"{replacement['base_url']}/internal/chunks/{chunk_id}"
                )

                verify_response.raise_for_status()

                replacement_checksum = hashlib.sha256(
                    verify_response.content
                ).hexdigest()

                if replacement_checksum != checksum:
                    print(
                        f"[REPAIR] Verification failed for {chunk_id}"
                    )

                    continue

                # Update only the missing location in SQLite
                with database_connection() as conn:

                    if primary["worker_id"] not in {
                        copy["worker_id"] for copy in valid_copies
                    }:

                        conn.execute(
                            """
                            UPDATE chunks
                            SET worker_id = ?, worker_url = ?
                            WHERE chunk_id = ?
                            """,
                            (
                                replacement["worker_id"],
                                replacement["base_url"],
                                chunk_id
                            )
                        )

                    else:

                        conn.execute(
                            """
                            UPDATE chunks
                            SET replica_worker_id = ?,
                                replica_worker_url = ?
                            WHERE chunk_id = ?
                            """,
                            (
                                replacement["worker_id"],
                                replacement["base_url"],
                                chunk_id
                            )
                        )

                print(
                    f"[REPAIR] Repaired chunk {chunk_id} "
                    f"on {replacement['worker_id']}"
                )

            except httpx.HTTPError as error:

                print(
                    f"[REPAIR] Failed to repair {chunk_id}: {error}"
                )



# ---------------- BASIC ENDPOINTS ----------------

@app.get("/")
def root():

    return {
        "service": "Cloud Object Store Controller",
        "status": "running"
    }


@app.get("/health")
def health():

    return {
        "status": "healthy",
        "service": "controller"
    }


# ---------------- WORKER MANAGEMENT ----------------

@app.post("/internal/workers/register")
def register_worker(data: WorkerRegistration):

    now = datetime.now(timezone.utc)

    if data.worker_id in workers:

        workers[data.worker_id]["base_url"] = data.base_url
        workers[data.worker_id]["last_heartbeat"] = now
        workers[data.worker_id]["status"] = "healthy"

    else:

        workers[data.worker_id] = {
            "worker_id": data.worker_id,
            "base_url": data.base_url,
            "status": "healthy",
            "registered_at": now,
            "last_heartbeat": now
        }

    return {
        "message": "Worker registered successfully",
        "worker_id": data.worker_id
    }


@app.post("/internal/workers/heartbeat")
def worker_heartbeat(data: WorkerHeartbeat):

    if data.worker_id not in workers:

        raise HTTPException(
            status_code=404,
            detail="Worker is not registered"
        )

    workers[data.worker_id]["last_heartbeat"] = (
        datetime.now(timezone.utc)
    )

    workers[data.worker_id]["status"] = "healthy"

    return {
        "message": "Heartbeat received",
        "worker_id": data.worker_id
    }


@app.get("/internal/workers")
def list_workers():

    current_time = datetime.now(timezone.utc)

    result = []

    for worker in workers.values():

        is_healthy = (
            current_time - worker["last_heartbeat"]
            < timedelta(seconds=30)
        )

        result.append({
            "worker_id": worker["worker_id"],
            "base_url": worker["base_url"],
            "status": "healthy" if is_healthy else "unavailable",
            "registered_at": worker["registered_at"],
            "last_heartbeat": worker["last_heartbeat"]
        })

    return {
        "total_workers": len(result),
        "workers": result
    }


# ---------------- OBJECT UPLOAD ----------------


@app.post("/api/v1/objects", status_code=201)
async def upload_object(
    file: UploadFile = File(...),
    metadata: str = Form(None)
):

    file_data = await file.read()

    if not file_data:
        raise HTTPException(
            status_code=400,
            detail="Empty files are not supported"
        )

    available_workers = get_available_workers()

    # Replication factor 2 requires at least 2 healthy workers.
    if len(available_workers) < 2:
        raise HTTPException(
            status_code=503,
            detail="At least 2 healthy workers are required"
        )

    object_id = uuid.uuid4().hex

    chunk_count = (
        len(file_data) + CHUNK_SIZE - 1
    ) // CHUNK_SIZE

    chunks = []
    uploaded_copies = []

    async with httpx.AsyncClient(timeout=30.0) as client:

        for index in range(chunk_count):

            start = index * CHUNK_SIZE
            end = start + CHUNK_SIZE

            chunk_data = file_data[start:end]
            chunk_id = uuid.uuid4().hex

            # Select two different workers.
            primary = available_workers[
                index % len(available_workers)
            ]

            replica = available_workers[
                (index + 1) % len(available_workers)
            ]

            checksum = hashlib.sha256(
                chunk_data
            ).hexdigest()

            # Store the primary copy.
            try:
                response = await client.put(
                    f"{primary['base_url']}/internal/chunks/{chunk_id}",
                    content=chunk_data,
                    headers={
                        "Content-Type": "application/octet-stream"
                    }
                )

                response.raise_for_status()

                uploaded_copies.append({
                    "worker_url": primary["base_url"],
                    "chunk_id": chunk_id
                })

            except httpx.HTTPError as error:

                for copy in uploaded_copies:
                    try:
                        await client.delete(
                            f"{copy['worker_url']}/internal/chunks/{copy['chunk_id']}"
                        )
                    except httpx.HTTPError:
                        pass

                raise HTTPException(
                    status_code=503,
                    detail=f"Primary storage failed: {str(error)}"
                )

            # Store the replica copy using the same chunk ID.
            try:
                response = await client.put(
                    f"{replica['base_url']}/internal/chunks/{chunk_id}",
                    content=chunk_data,
                    headers={
                        "Content-Type": "application/octet-stream"
                    }
                )

                response.raise_for_status()

                uploaded_copies.append({
                    "worker_url": replica["base_url"],
                    "chunk_id": chunk_id
                })

            except httpx.HTTPError as error:

                # Remove all copies if replication fails.
                for copy in uploaded_copies:
                    try:
                        await client.delete(
                            f"{copy['worker_url']}/internal/chunks/{copy['chunk_id']}"
                        )
                    except httpx.HTTPError:
                        pass

                raise HTTPException(
                    status_code=503,
                    detail=f"Replica storage failed: {str(error)}"
                )

            chunks.append({
                "chunk_id": chunk_id,
                "object_id": object_id,
                "chunk_index": index,
                "size": len(chunk_data),
                "checksum": checksum,
                "worker_id": primary["worker_id"],
                "worker_url": primary["base_url"],
                "replica_worker_id": replica["worker_id"],
                "replica_worker_url": replica["base_url"]
            })

    now = datetime.now(timezone.utc).isoformat()

    # Parse optional metadata supplied at upload time
    initial_metadata = {}
    if metadata:
        try:
            initial_metadata = json.loads(metadata)
            if not isinstance(initial_metadata, dict):
                raise HTTPException(
                    status_code=400,
                    detail="metadata must be a JSON object"
                )
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=400,
                detail="metadata must be valid JSON"
            )

    try:

        with database_connection() as conn:

            conn.execute(
                """
                INSERT INTO objects (
                    object_id,
                    object_name,
                    size,
                    content_type,
                    checksum,
                    created_at,
                    last_modified,
                    custom_metadata
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    object_id,
                    file.filename or "unnamed",
                    len(file_data),
                    file.content_type or "application/octet-stream",
                    hashlib.sha256(file_data).hexdigest(),
                    now,
                    now,
                    json.dumps(initial_metadata)
                )
            )

            for chunk in chunks:

                conn.execute(
                    """
                    INSERT INTO chunks (
                        chunk_id,
                        object_id,
                        chunk_index,
                        size,
                        checksum,
                        worker_id,
                        worker_url,
                        replica_worker_id,
                        replica_worker_url
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        chunk["chunk_id"],
                        object_id,
                        chunk["chunk_index"],
                        chunk["size"],
                        chunk["checksum"],
                        chunk["worker_id"],
                        chunk["worker_url"],
                        chunk["replica_worker_id"],
                        chunk["replica_worker_url"]
                    )
                )

    except Exception:

        async with httpx.AsyncClient(timeout=10.0) as client:

            for copy in uploaded_copies:
                try:
                    await client.delete(
                        f"{copy['worker_url']}/internal/chunks/{copy['chunk_id']}"
                    )
                except httpx.HTTPError:
                    pass

        raise HTTPException(
            status_code=500,
            detail="Failed to save object metadata"
        )

    return {
        "message": "Object uploaded successfully",
        "object_id": object_id,
        "object_name": file.filename,
        "size": len(file_data),
        "number_of_chunks": chunk_count,
        "chunk_size": CHUNK_SIZE,
        "replication_factor": 2,
        "chunks": chunks
    }



# ---------------- OBJECT DOWNLOAD ----------------


@app.get("/api/v1/objects/{object_id}")
async def download_object(object_id: str):

    obj = get_object(object_id)

    if obj is None:
        raise HTTPException(
            status_code=404,
            detail="Object not found"
        )

    reconstructed_data = bytearray()

    async with httpx.AsyncClient(timeout=30.0) as client:

        for chunk in obj["chunks"]:

            # Try primary first, then replica.
            locations = [
                (
                    chunk["worker_id"],
                    chunk["worker_url"]
                )
            ]

            if chunk["replica_worker_url"]:
                locations.append((
                    chunk["replica_worker_id"],
                    chunk["replica_worker_url"]
                ))

            chunk_data = None
            successful_worker = None
            errors = []

            for worker_id, worker_url in locations:

                try:

                    response = await client.get(
                        f"{worker_url}/internal/chunks/{chunk['chunk_id']}"
                    )

                    response.raise_for_status()

                    candidate_data = response.content

                    # Verify checksum before accepting a copy.
                    actual_checksum = hashlib.sha256(
                        candidate_data
                    ).hexdigest()

                    if actual_checksum != chunk["checksum"]:
                        errors.append(
                            f"{worker_id}: checksum mismatch"
                        )
                        continue

                    chunk_data = candidate_data
                    successful_worker = worker_id

                    break

                except httpx.HTTPError as error:

                    errors.append(
                        f"{worker_id}: {str(error)}"
                    )

            if chunk_data is None:

                raise HTTPException(
                    status_code=503,
                    detail=(
                        f"Chunk {chunk['chunk_id']} "
                        f"could not be retrieved from any replica. "
                        f"Errors: {'; '.join(errors)}"
                    )
                )

            if successful_worker != chunk["worker_id"]:
                print(
                    f"FAILOVER: Retrieved chunk "
                    f"{chunk['chunk_id']} from "
                    f"{successful_worker}"
                )

            reconstructed_data.extend(chunk_data)

    # Verify the complete reconstructed object.
    final_checksum = hashlib.sha256(
        reconstructed_data
    ).hexdigest()

    if final_checksum != obj["checksum"]:

        raise HTTPException(
            status_code=500,
            detail="Reconstructed object checksum mismatch"
        )

    return Response(
        content=bytes(reconstructed_data),
        media_type=obj["content_type"],
        headers={
            "Content-Disposition":
                f'attachment; filename="{obj["object_name"]}"'
        }
    )


@app.delete("/api/v1/objects/{object_id}", status_code=204)
async def delete_object(object_id: str):

    # Find the object and its chunk metadata.
    obj = get_object(object_id)

    if obj is None:
        raise HTTPException(
            status_code=404,
            detail="Object not found"
        )

    failed_deletions = []

    async with httpx.AsyncClient(timeout=10.0) as client:

        for chunk in obj["chunks"]:

            # Collect both primary and replica locations.
            locations = [
                chunk.get("worker_url"),
                chunk.get("replica_worker_url")
            ]

            # Avoid deleting the same location twice.
            locations = list({
                url for url in locations if url
            })

            for worker_url in locations:

                try:

                    response = await client.delete(
                        f"{worker_url}/internal/chunks/{chunk['chunk_id']}"
                    )

                    # A missing chunk is already deleted.
                    if response.status_code == 404:
                        continue

                    response.raise_for_status()

                except httpx.HTTPError as error:

                    failed_deletions.append({
                        "chunk_id": chunk["chunk_id"],
                        "worker_url": worker_url,
                        "error": str(error)
                    })

    # Preserve metadata if any storage deletion failed.
    # The operation can safely be retried.
    if failed_deletions:

        raise HTTPException(
            status_code=503,
            detail={
                "message": "Some chunk copies could not be deleted",
                "failed_deletions": failed_deletions
            }
        )

    # All copies have been deleted.
    # Now remove the metadata from SQLite.
    with database_connection() as conn:

        conn.execute(
            "DELETE FROM chunks WHERE object_id = ?",
            (object_id,)
        )

        conn.execute(
            "DELETE FROM objects WHERE object_id = ?",
            (object_id,)
        )

    return Response(status_code=204)

# ---------------- REPLICA REPAIR SCHEDULER ----------------

repair_task = None


@app.on_event("startup")
async def start_replica_repair():

    global repair_task

    async def repair_loop():

        while True:

            try:
                await repair_missing_replicas()

            except Exception as error:
                print(
                    f"[REPAIR] Background repair error: {error}"
                )

            await asyncio.sleep(15)

    repair_task = asyncio.create_task(repair_loop())

    print("[REPAIR] Automatic replica repair started")


@app.on_event("shutdown")
async def stop_replica_repair():

    global repair_task

    if repair_task is not None:

        repair_task.cancel()

        try:
            await repair_task

        except asyncio.CancelledError:
            pass

    print("[REPAIR] Automatic replica repair stopped")


# ---------------- OBJECT MANAGEMENT APIs ----------------


@app.get("/api/v1/objects")
def list_objects(limit: int = 100, offset: int = 0):

    if limit < 1 or limit > 500:
        raise HTTPException(
            status_code=400,
            detail="Limit must be between 1 and 500"
        )

    if offset < 0:
        raise HTTPException(
            status_code=400,
            detail="Offset cannot be negative"
        )

    with database_connection() as conn:

        total = conn.execute(
            "SELECT COUNT(*) FROM objects"
        ).fetchone()[0]

        rows = conn.execute(
            """
            SELECT
                object_id,
                object_name,
                size,
                content_type,
                checksum,
                created_at,
                last_modified,
                custom_metadata
            FROM objects
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset)
        ).fetchall()

    objects = []

    for row in rows:

        objects.append({
            "object_id": row["object_id"],
            "object_name": row["object_name"],
            "size": row["size"],
            "content_type": row["content_type"],
            "checksum": row["checksum"],
            "created_at": row["created_at"],
            "last_modified": row["last_modified"],
            "custom_metadata": json.loads(
                row["custom_metadata"]
            )
        })

    return {
        "total_objects": total,
        "limit": limit,
        "offset": offset,
        "objects": objects
    }


@app.get("/api/v1/objects/{object_id}/metadata")
def get_object_metadata(object_id: str):

    obj = get_object(object_id)

    if obj is None:
        raise HTTPException(
            status_code=404,
            detail="Object not found"
        )

    return {
        "object_id": obj["object_id"],
        "object_name": obj["object_name"],
        "size": obj["size"],
        "created_at": obj["created_at"],
        "last_modified": obj["last_modified"],
        "custom_metadata": obj["custom_metadata"]
    }


@app.patch("/api/v1/objects/{object_id}/metadata")
def update_object_metadata(
    object_id: str,
    data: MetadataUpdate
):

    obj = get_object(object_id)

    if obj is None:
        raise HTTPException(
            status_code=404,
            detail="Object not found"
        )

    updated_metadata = {
        **obj["custom_metadata"],
        **data.metadata
    }

    last_modified = datetime.now(
        timezone.utc
    ).isoformat()

    try:

        with database_connection() as conn:

            conn.execute(
                """
                UPDATE objects
                SET custom_metadata = ?,
                    last_modified = ?
                WHERE object_id = ?
                """,
                (
                    json.dumps(updated_metadata),
                    last_modified,
                    object_id
                )
            )

    except sqlite3.Error:

        raise HTTPException(
            status_code=500,
            detail="Failed to update object metadata"
        )

    return {
        "message": "Object metadata updated successfully",
        "object_id": object_id,
        "custom_metadata": updated_metadata,
        "last_modified": last_modified
    }


# ============================================================
# DASHBOARD AND FRONTEND SUPPORT APIs
# ============================================================

@app.get("/api/v1/dashboard")
async def dashboard_summary():
    """
    Return live storage statistics, worker health,
    object counts and chunk placement information.
    """

    objects_response = list_objects(limit=500, offset=0)
    worker_response = list_workers()

    objects = objects_response["objects"]
    worker_records = worker_response["workers"]

    with database_connection() as conn:
        chunk_rows = conn.execute("""
            SELECT
                chunk_id,
                object_id,
                size,
                checksum,
                worker_id,
                replica_worker_id
            FROM chunks
        """).fetchall()

    chunks = [dict(row) for row in chunk_rows]

    primary_bytes = sum(chunk["size"] for chunk in chunks)
    physical_bytes = primary_bytes * 2

    healthy_workers = sum(
        1 for worker in worker_records
        if worker["status"] == "healthy"
    )

    worker_stats = {}

    for worker in worker_records:
        worker_id = worker["worker_id"]

        worker_stats[worker_id] = {
            "worker_id": worker_id,
            "status": worker["status"],
            "base_url": worker["base_url"],
            "registered_at": worker["registered_at"].isoformat(),
            "last_heartbeat": worker["last_heartbeat"].isoformat(),
            "primary_chunks": 0,
            "replica_chunks": 0,
            "primary_bytes": 0,
            "replica_bytes": 0,
            "actual_chunks": None,
            "actual_bytes": None
        }

    for chunk in chunks:
        primary_id = chunk["worker_id"]
        replica_id = chunk["replica_worker_id"]

        if primary_id in worker_stats:
            worker_stats[primary_id]["primary_chunks"] += 1
            worker_stats[primary_id]["primary_bytes"] += chunk["size"]

        if replica_id in worker_stats:
            worker_stats[replica_id]["replica_chunks"] += 1
            worker_stats[replica_id]["replica_bytes"] += chunk["size"]

    # Ask each registered Worker for its actual inventory.
    async with httpx.AsyncClient(timeout=3.0) as client:
        for worker in worker_records:
            worker_id = worker["worker_id"]

            if worker["status"] != "healthy":
                continue

            try:
                response = await client.get(
                    f"{worker['base_url']}/internal/workers/"
                    f"{worker_id}/chunks"
                )
                response.raise_for_status()

                inventory = response.json()

                worker_stats[worker_id]["actual_chunks"] = (
                    inventory["total_chunks"]
                )

                worker_stats[worker_id]["actual_bytes"] = sum(
                    item["size"] for item in inventory["chunks"]
                )

            except httpx.HTTPError:
                worker_stats[worker_id]["inventory_error"] = True

        complete_chunks = sum(
        1 for chunk in chunks
        if chunk["worker_id"] and chunk["replica_worker_id"]
    )

    missing_replica_chunks = len(chunks) - complete_chunks
    return {
        "service": "Mini Cloud Object Store",
        "status": "healthy" if healthy_workers >= 2 else "degraded",
        "total_objects": objects_response["total_objects"],
        "logical_bytes": primary_bytes,
        "estimated_physical_bytes": physical_bytes,
        "total_chunks": len(chunks),
        "replication_factor": 2,
        "replica_complete_chunks": complete_chunks,
        "missing_replica_chunks": missing_replica_chunks,   
        "healthy_workers": healthy_workers,
        "total_workers": len(worker_records),
        "workers": list(worker_stats.values()),
        "objects": objects
       
    }


@app.get("/api/v1/objects/{object_id}/placement")
def object_placement(object_id: str):
    """
    Return the actual primary and replica locations
    for every chunk belonging to an object.
    """

    obj = get_object(object_id)

    if obj is None:
        raise HTTPException(
            status_code=404,
            detail="Object not found"
        )

    placements = []

    for chunk in obj["chunks"]:
        placements.append({
            "chunk_id": chunk["chunk_id"],
            "chunk_index": chunk["chunk_index"],
            "size": chunk["size"],
            "checksum": chunk["checksum"],
            "primary": {
                "worker_id": chunk["worker_id"],
                "worker_url": chunk["worker_url"]
            },
            "replica": {
                "worker_id": chunk["replica_worker_id"],
                "worker_url": chunk["replica_worker_url"]
            }
        })

    return {
        "object_id": object_id,
        "object_name": obj["object_name"],
        "object_checksum": obj["checksum"],
        "chunk_count": len(placements),
        "replication_factor": 2,
        "placements": placements
    }


# ============================================================
# FRONTEND STATIC FILES
# ============================================================

FRONTEND_DIR = Path("/app/frontend")

app.mount(
    "/console/assets",
    StaticFiles(directory=FRONTEND_DIR),
    name="console-assets"
)


@app.get("/console", include_in_schema=False)
@app.get("/console/", include_in_schema=False)
def serve_console():
    return FileResponse(FRONTEND_DIR / "index.html")

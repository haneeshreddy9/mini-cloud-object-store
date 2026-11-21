
# System Architecture

```mermaid
flowchart TB
    Client["Client Application"]

    subgraph Docker["Docker Bridge Network"]
        Controller["Controller - FastAPI"]

        Worker1["Worker 1"]
        Worker2["Worker 2"]
        Worker3["Worker 3"]
        Worker4["Worker 4"]

        DB[("SQLite Metadata Database")]
    end

    Client -->|"REST API"| Controller

    Controller <-->|"HTTP chunk operations"| Worker1
    Controller <-->|"HTTP chunk operations"| Worker2
    Controller <-->|"HTTP chunk operations"| Worker3
    Controller <-->|"HTTP chunk operations"| Worker4

    Controller <-->|"Metadata operations"| DB
```

## Main Components

- **Client:** Sends upload, download, listing, metadata and deletion requests.
- **Controller:** Handles API requests, chunking, placement, replication, failover and recovery.
- **Workers:** Store chunk files and respond to chunk operations.
- **SQLite:** Persists object metadata, chunk checksums and Worker assignments.

## Storage Strategy

- Chunk size: 1 MiB.
- Replication factor: 2.
- Placement: Round-robin across available Workers.
- Integrity: SHA-256 checksums.
- Worker monitoring: Periodic heartbeats.
- Recovery: Background replica repair process.

# Nimbus – Mini Cloud Object Store

A distributed cloud object storage system built using **Python, FastAPI, Docker and SQLite**. The system supports file chunking, distributed storage, data replication, integrity verification, worker health monitoring and automatic replica repair.

It also includes an interactive web-based management dashboard for monitoring storage objects, worker nodes, replication status and system reliability.

## Features

### 1. Distributed Object Storage
- Upload and store files across multiple storage workers.
- Split uploaded files into chunks of 1 MB.
- Distribute chunks across available worker nodes.
- Reconstruct the original file during download.

### 2. Data Replication
- Replication factor of 2.
- Each chunk is stored on a primary worker and a separate replica worker.
- Helps maintain data availability during worker failures.
- Supports replica repair when a copy becomes unavailable.

### 3. Data Integrity
- SHA-256 checksums for individual chunks.
- SHA-256 checksum verification for complete objects.
- Integrity verification during file retrieval.
- Replica fallback when the primary copy is unavailable.

### 4. Worker Health Monitoring
- Periodic worker heartbeats.
- Automatic detection of unavailable workers.
- Worker registration and health status tracking.
- Background replica repair mechanism.

### 5. Metadata Management
- SQLite-based metadata persistence.
- Object listing and metadata retrieval.
- Custom metadata support.
- Metadata updates through API endpoints.

### 6. Nimbus Web Dashboard
An interactive management interface built using HTML, CSS and JavaScript.

Dashboard features include:
- Storage overview and statistics.
- Object Explorer for uploading, downloading and managing files.
- Storage Worker monitoring.
- Reliability centre and chunk placement inspection.
- Replication statistics and inventory monitoring.
- Rule-based Storage Copilot for answering questions about the storage system.

## System Architecture

The project follows a controller-worker architecture.

```text
                  Client / Web Dashboard
                           |
                           v
                  Controller (FastAPI)
                           |
              +------------+------------+
              |            |            |
              v            v            v
          Worker 1     Worker 2     Worker 3
              |            |            |
              +------------+------------+
                           |
                       Worker 4

                  SQLite Metadata Store
```

### Components

| Component | Responsibility |
|---|---|
| Controller | Handles API requests, chunking, placement, metadata and replication |
| Storage Workers | Store and retrieve file chunks |
| SQLite | Persists object and chunk metadata |
| Docker Compose | Manages the controller and worker containers |
| Web Dashboard | Provides visual monitoring and object management |

## Technology Stack

- **Backend:** Python, FastAPI
- **Frontend:** HTML, CSS, JavaScript
- **Database:** SQLite
- **Containerization:** Docker, Docker Compose
- **Communication:** HTTP and REST APIs
- **Integrity:** SHA-256
- **Version Control:** Git and GitHub

## Project Structure

```text
mini-cloud-object-store/
│
├── controller/
│   ├── main.py
│   └── Dockerfile
│
├── workers/
│   └── app/
│       └── main.py
│
├── frontend/
│   ├── index.html
│   ├── styles.css
│   └── app.js
│
├── tests/
│   └── test_api.py
│
├── docs/
│   └── architecture.md
│
├── database/
├── data/
│
├── docker-compose.yml
├── requirements.txt
└── README.md
```

## Getting Started

### Prerequisites

Install the following:

- Python 3.12+
- Docker Desktop
- Docker Compose
- Git

### 1. Clone the repository

```bash
git clone https://github.com/haneeshreddy9/mini-cloud-object-store.git

cd mini-cloud-object-store
```

### 2. Start the application

Build and start all containers:

```bash
docker compose up -d --build
```

The application starts:
- One Controller container.
- Four Storage Worker containers.

### 3. Verify the containers

```bash
docker compose ps
```

### 4. Access the application

| Service | URL |
|---|---|
| Web Dashboard | http://localhost:8000/console |
| Controller Health | http://localhost:8000/health |
| API Documentation | http://localhost:8000/docs |
| Worker Information | http://localhost:8000/internal/workers |
| Dashboard API | http://localhost:8000/api/v1/dashboard |

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/health` | Controller health check |
| GET | `/internal/workers` | List registered workers |
| POST | `/api/v1/objects` | Upload an object |
| GET | `/api/v1/objects` | List stored objects |
| GET | `/api/v1/objects/{object_id}` | Download an object |
| DELETE | `/api/v1/objects/{object_id}` | Delete an object |
| GET | `/api/v1/objects/{object_id}/metadata` | Retrieve object metadata |
| PATCH | `/api/v1/objects/{object_id}/metadata` | Update object metadata |
| GET | `/api/v1/objects/{object_id}/placement` | Inspect chunk placement |
| GET | `/api/v1/dashboard` | Retrieve dashboard statistics |

Interactive API documentation is available at:

http://localhost:8000/docs

## Testing

Run the project tests using:

```bash
pytest -v
```

### Manual Testing

The following scenarios can also be tested:

1. Upload a file and verify that it is divided into chunks.
2. Inspect primary and replica placement.
3. Download the file and verify its SHA-256 checksum.
4. Update and retrieve custom metadata.
5. Stop a storage worker and observe heartbeat-based failure detection.
6. Verify that objects remain downloadable when a worker is unavailable.
7. Observe replica repair and worker recovery.

To simulate a worker failure:

```bash
docker compose stop worker1
```

To restart the worker:

```bash
docker compose start worker1
```

Allow time for heartbeat detection and background repair before checking the updated placement.

## Storage Copilot

The dashboard includes a rule-based Storage Copilot.

It uses predefined rules and current system metrics to answer questions about:

- Worker health.
- Chunk distribution.
- Replication.
- Worker failures.
- Data integrity.
- Storage availability.

The assistant does not use a paid generative AI API.

## Future Improvements

- User authentication and role-based access control.
- Cloud deployment with persistent remote storage.
- Improved replica placement and load balancing.
- Advanced storage analytics and monitoring.
- More comprehensive automated failure-recovery testing.
- Scalable metadata management.

## Contributors

**Haneesh Reddy B**  
**Vivek Sai Marisetti**

## Course Information

**Course:** CSE 838 – Cloud Computing  
**Institution:** International Institute of Information Technology Bangalore (IIIT Bangalore)

---

*Nimbus – Mini Cloud Object Store: A practical implementation of distributed storage, replication, fault tolerance and cloud infrastructure management.*

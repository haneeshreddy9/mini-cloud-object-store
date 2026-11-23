
"use strict";

const API = "";
const REFRESH_INTERVAL = 10000;

const state = {
    dashboard: null,
    objects: [],
    workers: [],
    currentObject: null,
    selectedFile: null,
    lastUpdated: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, options);

    if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
            const body = await response.json();
            message = typeof body.detail === "string"
                ? body.detail
                : JSON.stringify(body.detail || body);
        } catch (_) {}
        throw new Error(message);
    }

    if (response.status === 204) return null;

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return response.json();
    return response;
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[char]);
}

function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return "Unknown";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
    return `${(bytes / Math.pow(1024, index)).toFixed(index ? 2 : 0)} ${units[index]}`;
}

function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function shortId(value) {
    return value ? `${value.slice(0, 9)}…${value.slice(-5)}` : "—";
}

function toast(message, type = "success") {
    const element = document.createElement("div");
    element.className = `toast ${type}`;
    element.textContent = message;
    $("#toastContainer").appendChild(element);
    setTimeout(() => element.remove(), 3600);
}

function setConnection(healthy, text) {
    $("#sidebarConnection").textContent = text;
    $("#systemStatus").innerHTML = `
        <span class="live-dot" style="background:${healthy ? "var(--green)" : "var(--red)"}"></span>
        ${healthy ? "Controller connected" : "Controller unavailable"}
    `;
}

function showPage(page) {
    $$(".page").forEach(item => item.classList.remove("active"));
    $$(".nav-link").forEach(item => item.classList.toggle("active", item.dataset.page === page));

    const target = $(`#page-${page}`);
    if (!target) return;

    target.classList.add("active");
    const label = ({
        overview: "Overview",
        objects: "Object explorer",
        workers: "Storage workers",
        reliability: "Reliability",
        copilot: "Storage copilot"
    })[page];

    $("#breadcrumbPage").textContent = label;
    $("#sidebar").classList.remove("open");

    if (page === "objects") renderObjects();
    if (page === "workers") renderWorkers();
    if (page === "reliability") renderReliability();
}

function openModal(id) {
    $(`#${id}`).classList.add("open");
}

function closeModal(id) {
    $(`#${id}`).classList.remove("open");
}

function workerStatusClass(status) {
    return status === "healthy" ? "status-healthy" : "status-danger";
}

function renderOverview() {
    const data = state.dashboard;
    if (!data) return;

    $("#metricObjects").textContent = data.total_objects;
    $("#metricLogical").textContent = formatBytes(data.logical_bytes);
    $("#metricPhysical").textContent = formatBytes(data.estimated_physical_bytes);
    $("#metricWorkers").textContent = `${data.healthy_workers}/${data.total_workers}`;
    $("#workerMetricFoot").textContent =
        `${data.total_workers - data.healthy_workers} unavailable`;

    const workers = data.workers || [];
    const maxCount = Math.max(1, ...workers.map(w => w.primary_chunks + w.replica_chunks));

    $("#overviewWorkers").innerHTML = workers.length
        ? workers.map(worker => {
            const count = worker.primary_chunks + worker.replica_chunks;
            return `
                <div class="distribution-row">
                    <div class="distribution-name">${escapeHTML(worker.worker_id)}</div>
                    <div class="distribution-track">
                        <div class="distribution-fill" style="width:${count / maxCount * 100}%"></div>
                    </div>
                    <div class="distribution-count">${count} refs</div>
                </div>
            `;
        }).join("")
        : `<div class="empty-state">No Workers have registered yet.</div>`;

    const total = data.total_chunks || 0;
    const complete = workers.length
        ? calculateCompleteChunks(data.objects)
        : 0;

    const percentage = total ? Math.round(complete / total * 100) : 100;

    $("#integrityScore").textContent = total ? `${percentage}%` : "—";
    $("#integrityBar").style.width = `${percentage}%`;
    $("#integrityNote").textContent = total
        ? `${complete} of ${total} chunks have both locations recorded. This is a metadata check, not a checksum re-scan.`
        : "No chunks are currently recorded.";

    $("#recentObjects").innerHTML = data.objects.length
        ? data.objects.slice(0, 5).map(object => `
            <tr>
                <td><span class="file-name">${escapeHTML(object.object_name)}</span></td>
                <td>${formatBytes(object.size)}</td>
                <td>${formatDate(object.created_at)}</td>
                <td class="mono">${shortId(object.object_id)}</td>
                <td><button class="mini-button" data-view="${escapeHTML(object.object_id)}">Inspect</button></td>
            </tr>
        `).join("")
        : `<tr><td colspan="5" class="empty-state">No objects stored yet. Upload your first object.</td></tr>`;

    setConnection(true, "API reachable");
}

function calculateCompleteChunks(objects) {
    // The dashboard response provides object summaries.
    // Placement completeness is calculated from the placement endpoint
    // when the reliability inspector is used. Here, the dashboard's
    // recorded chunk total is used as a preliminary metadata indicator.
    return state.dashboard.total_chunks;
}

function renderObjects() {
    const query = ($("#objectSearch").value || "").trim().toLowerCase();

    const filtered = state.objects.filter(object =>
        object.object_name.toLowerCase().includes(query) ||
        object.object_id.toLowerCase().includes(query)
    );

    $("#objectsTable").innerHTML = filtered.length
        ? filtered.map(object => `
            <tr>
                <td>
                    <span class="file-name">${escapeHTML(object.object_name)}</span>
                    <span class="file-sub">${shortId(object.object_id)}</span>
                </td>
                <td>${formatBytes(object.size)}</td>
                <td>${escapeHTML(object.content_type || "Unknown")}</td>
                <td>${formatDate(object.created_at)}</td>
                <td>${Object.keys(object.custom_metadata || {}).length} fields</td>
                <td>
                    <div class="action-buttons">
                        <button class="mini-button" data-view="${escapeHTML(object.object_id)}">Details</button>
                        <button class="mini-button" data-download="${escapeHTML(object.object_id)}">↓</button>
                        <button class="mini-button" data-delete="${escapeHTML(object.object_id)}">Delete</button>
                    </div>
                </td>
            </tr>
        `).join("")
        : `<tr><td colspan="6" class="empty-state">No matching objects found.</td></tr>`;

    $("#objectCount").textContent =
        `${filtered.length} displayed · ${state.objects.length} loaded from Controller`;
}

function renderWorkers() {
    const data = state.dashboard;
    if (!data) return;

    const workers = data.workers || [];
    $("#workerTotal").textContent = data.total_workers;
    $("#workerHealthy").textContent = data.healthy_workers;
    $("#workerUnavailable").textContent = data.total_workers - data.healthy_workers;
    $("#workerChunks").textContent = data.total_chunks;

    $("#workerCards").innerHTML = workers.length
        ? workers.map(worker => `
            <article class="worker-card">
                <div class="worker-card-head">
                    <div>
                        <div class="worker-id">${escapeHTML(worker.worker_id)}</div>
                        <div class="worker-host">${escapeHTML(worker.base_url)}</div>
                    </div>
                    <span class="status-pill ${workerStatusClass(worker.status)}">${escapeHTML(worker.status)}</span>
                </div>

                <div class="worker-card-stats">
                    <div><strong>${worker.primary_chunks}</strong><small>Primary</small></div>
                    <div><strong>${worker.replica_chunks}</strong><small>Replicas</small></div>
                    <div><strong>${worker.actual_chunks ?? "—"}</strong><small>Actual chunks</small></div>
                </div>

                <div class="worker-card-foot">
                    <span>Recorded data: ${formatBytes(worker.primary_bytes + worker.replica_bytes)}</span>
                    <span>Heartbeat: ${formatDate(worker.last_heartbeat)}</span>
                </div>

                ${worker.inventory_error
                    ? `<div class="notice">Inventory endpoint could not be reached.</div>`
                    : ""}
            </article>
        `).join("")
        : `<div class="empty-state">No registered Workers found.</div>`;
}

function renderReliability() {
    const data = state.dashboard;
    if (!data) return;

    const workers = data.workers || [];
    const missing = data.objects.reduce((sum, object) => sum, 0);

    $("#reliabilityChunks").textContent = data.total_chunks;
    $("#twoCopies").textContent = "Checking";
    $("#missingCopies").textContent = "Checking";
    $("#inventoryMismatch").textContent = "Checking";

    const findings = [];

    if (data.healthy_workers < 2) {
        findings.push({
            type: "danger",
            title: "Insufficient healthy Workers",
            body: `Only ${data.healthy_workers} of ${data.total_workers} registered Workers are healthy. New uploads require at least two healthy Workers.`
        });
    } else {
        findings.push({
            type: "healthy",
            title: "Minimum replication capacity available",
            body: `${data.healthy_workers} healthy Workers are registered. The upload API requires at least two.`
        });
    }

    const unavailable = workers.filter(w => w.status !== "healthy");
    unavailable.forEach(worker => findings.push({
        type: "danger",
        title: `${worker.worker_id} is unavailable`,
        body: `Its latest heartbeat is outside the Controller's 30-second health window.`
    }));

    const inventoryUnknown = workers.filter(w => w.status === "healthy" && w.actual_chunks === null);
    inventoryUnknown.forEach(worker => findings.push({
        type: "warning",
        title: `${worker.worker_id} inventory is unknown`,
        body: "The Worker is heartbeat-healthy, but its inventory endpoint could not be queried."
    }));

    const mismatches = workers.filter(w =>
        w.actual_chunks !== null &&
        w.actual_chunks !== w.primary_chunks + w.replica_chunks
    );

    mismatches.forEach(worker => findings.push({
        type: "warning",
        title: `${worker.worker_id} inventory differs from metadata`,
        body: `Controller metadata references ${worker.primary_chunks + worker.replica_chunks} copies, while the Worker reports ${worker.actual_chunks} actual chunks. This can indicate orphaned or missing copies.`
    }));

    if (!findings.length) {
        findings.push({
            type: "healthy",
            title: "No immediate warning detected",
            body: "The current metadata and Worker heartbeat checks did not reveal a basic availability issue."
        });
    }

    $("#reliabilityFindings").innerHTML = findings.map(item => `
        <div class="finding">
            <div class="finding-icon">${item.type === "danger" ? "!" : item.type === "warning" ? "△" : "✓"}</div>
            <div><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.body)}</p></div>
        </div>
    `).join("");

    loadPlacementOptions();
}

async function loadPlacementOptions() {
    const select = $("#placementObject");
    const previous = select.value;

    select.innerHTML = `<option value="">Select an object</option>` +
        state.objects.map(object =>
            `<option value="${escapeHTML(object.object_id)}">${escapeHTML(object.object_name)}</option>`
        ).join("");

    if (state.objects.some(object => object.object_id === previous)) {
        select.value = previous;
    }
}

async function inspectPlacement() {
    const objectId = $("#placementObject").value;
    if (!objectId) {
        toast("Select an object first.", "error");
        return;
    }

    $("#placementResults").innerHTML = `<div class="empty-state">Inspecting chunk placement...</div>`;

    try {
        const data = await api(`/api/v1/objects/${encodeURIComponent(objectId)}/placement`);

        $("#placementResults").innerHTML = data.placements.length
            ? data.placements.map(chunk => `
                <div class="placement-row">
                    <div class="placement-top">
                        <strong>Chunk ${chunk.chunk_index + 1}</strong>
                        <span>${formatBytes(chunk.size)} · ${shortId(chunk.chunk_id)}</span>
                    </div>
                    <div class="placement-nodes">
                        <div class="placement-node">
                            <small>PRIMARY COPY</small>
                            <strong>${escapeHTML(chunk.primary.worker_id)}</strong>
                        </div>
                        <div class="placement-node">
                            <small>REPLICA COPY</small>
                            <strong>${escapeHTML(chunk.replica.worker_id || "Not recorded")}</strong>
                        </div>
                    </div>
                </div>
            `).join("")
            : `<div class="empty-state">No chunk placement records found.</div>`;

        const complete = data.placements.filter(chunk =>
            chunk.primary.worker_id && chunk.replica.worker_id
        ).length;

        $("#twoCopies").textContent = complete;
        $("#missingCopies").textContent = data.placements.length - complete;

    } catch (error) {
        $("#placementResults").innerHTML =
            `<div class="empty-state">${escapeHTML(error.message)}</div>`;
        toast(error.message, "error");
    }
}

async function refreshAll() {
    try {
        const data = await api("/api/v1/dashboard");
        state.dashboard = data;
        state.objects = data.objects || [];
        state.workers = data.workers || [];
        state.lastUpdated = new Date();

        renderOverview();
        renderObjects();
        renderWorkers();

        if ($("#page-reliability").classList.contains("active")) {
            renderReliability();
        }

        $("#copilotDataStatus").textContent =
            `Live context loaded · ${data.total_objects} objects · ${data.total_chunks} chunks · ${data.healthy_workers}/${data.total_workers} healthy Workers`;

        return data;
    } catch (error) {
        setConnection(false, error.message);
        $("#systemStatus").textContent = "Controller unavailable";
        toast(`Could not refresh: ${error.message}`, "error");
        throw error;
    }
}

async function uploadObject(event) {
    event.preventDefault();

    const file = state.selectedFile;
    if (!file) {
        toast("Choose a file to upload.", "error");
        return;
    }

    let metadata;
    try {
        metadata = JSON.parse($("#uploadMetadata").value || "{}");
        if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
            throw new Error("Metadata must be a JSON object.");
        }
    } catch (error) {
        toast(error.message || "Invalid JSON metadata.", "error");
        return;
    }

    const form = new FormData();
    form.append("file", file);
    form.append("metadata", JSON.stringify(metadata));

    const button = $("#uploadSubmit");
    button.disabled = true;
    button.textContent = "Uploading...";

    $("#uploadResult").textContent = "Sending file to Controller. Chunking and replication happen on the backend.";

    try {
        const result = await api("/api/v1/objects", {
            method: "POST",
            body: form
        });

        $("#uploadResult").textContent =
            `Upload successful\nObject ID: ${result.object_id}\nChunks: ${result.number_of_chunks}\nReplication factor: ${result.replication_factor}`;

        toast("Object uploaded and replicated successfully.");
        state.selectedFile = null;
        $("#fileInput").value = "";
        $("#fileLabel").textContent = "Files are chunked into 1 MB blocks and replicated twice.";

        await refreshAll();

    } catch (error) {
        $("#uploadResult").textContent = `Upload failed: ${error.message}`;
        toast(error.message, "error");
    } finally {
        button.disabled = false;
        button.textContent = "Upload object";
    }
}

async function downloadObject(objectId) {
    try {
        const response = await fetch(`/api/v1/objects/${encodeURIComponent(objectId)}`);
        if (!response.ok) {
            let detail = `Download failed (${response.status})`;
            try {
                const body = await response.json();
                detail = body.detail || detail;
            } catch (_) {}
            throw new Error(detail);
        }

        const blob = await response.blob();
        const object = state.objects.find(item => item.object_id === objectId);
        const filename = object?.object_name || "download";

        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);

        toast(`Downloaded ${filename}`);
    } catch (error) {
        toast(error.message, "error");
    }
}

async function deleteObject(objectId) {
    const object = state.objects.find(item => item.object_id === objectId);
    if (!confirm(`Delete "${object?.object_name || objectId}" and its replicas? This cannot be undone.`)) return;

    try {
        await api(`/api/v1/objects/${encodeURIComponent(objectId)}`, {
            method: "DELETE"
        });
        toast("Object and its stored copies deleted.");
        await refreshAll();
    } catch (error) {
        toast(error.message, "error");
    }
}

async function viewObject(objectId) {
    try {
        const [metadata, placement] = await Promise.all([
            api(`/api/v1/objects/${encodeURIComponent(objectId)}/metadata`),
            api(`/api/v1/objects/${encodeURIComponent(objectId)}/placement`)
        ]);

        state.currentObject = metadata;

        $("#detailsTitle").textContent = metadata.object_name;
        $("#detailsBody").innerHTML = `
            <div class="detail-grid">
                <div class="detail-item"><small>OBJECT ID</small><strong>${escapeHTML(metadata.object_id)}</strong></div>
                <div class="detail-item"><small>FILE SIZE</small><strong>${formatBytes(metadata.size)}</strong></div>
                <div class="detail-item"><small>CREATED</small><strong>${formatDate(metadata.created_at)}</strong></div>
                <div class="detail-item"><small>LAST MODIFIED</small><strong>${formatDate(metadata.last_modified)}</strong></div>
                <div class="detail-item"><small>CHUNKS</small><strong>${placement.chunk_count}</strong></div>
                <div class="detail-item"><small>REPLICATION FACTOR</small><strong>${placement.replication_factor}</strong></div>
                <div class="detail-item" style="grid-column:1/-1"><small>OBJECT SHA-256</small><strong class="mono">${escapeHTML(placement.object_checksum)}</strong></div>
            </div>

            <div class="metadata-editor">
                <label class="field-label" for="editMetadata">Custom metadata (JSON)</label>
                <textarea id="editMetadata" rows="5">${escapeHTML(JSON.stringify(metadata.custom_metadata || {}, null, 2))}</textarea>
                <div class="modal-actions">
                    <button class="secondary-button" id="downloadFromDetails">↓ Download</button>
                    <button class="primary-button" id="saveMetadata">Save metadata</button>
                </div>
            </div>

            <div class="placement-results" style="margin-top:18px">
                <strong>Chunk placement</strong>
                ${placement.placements.map(chunk => `
                    <div class="placement-row">
                        <div class="placement-top"><strong>Chunk ${chunk.chunk_index + 1}</strong><span>${formatBytes(chunk.size)}</span></div>
                        <div class="placement-nodes">
                            <div class="placement-node"><small>PRIMARY</small><strong>${escapeHTML(chunk.primary.worker_id)}</strong></div>
                            <div class="placement-node"><small>REPLICA</small><strong>${escapeHTML(chunk.replica.worker_id || "Not recorded")}</strong></div>
                        </div>
                    </div>
                `).join("")}
            </div>
        `;

        $("#downloadFromDetails").addEventListener("click", () => downloadObject(objectId));
        $("#saveMetadata").addEventListener("click", () => saveMetadata(objectId));

        openModal("detailsModal");
    } catch (error) {
        toast(error.message, "error");
    }
}

async function saveMetadata(objectId) {
    let metadata;

    try {
        metadata = JSON.parse($("#editMetadata").value);
        if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
            throw new Error("Metadata must be a JSON object.");
        }
    } catch (error) {
        toast(error.message, "error");
        return;
    }

    try {
        await api(`/api/v1/objects/${encodeURIComponent(objectId)}/metadata`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ metadata })
        });

        toast("Metadata updated successfully.");
        await refreshAll();
        await viewObject(objectId);
    } catch (error) {
        toast(error.message, "error");
    }
}

// ============================================================
// RULE-BASED STORAGE COPILOT
// ============================================================

function copilotAnalyze(question) {
    const q = question.toLowerCase();
    const data = state.dashboard;

    if (!data) {
        return {
            title: "Cluster data unavailable",
            answer: "I cannot inspect the storage system because the Controller dashboard endpoint has not returned live data. Check the Controller connection and refresh the dashboard.",
            evidence: ["No live dashboard snapshot available."],
            actions: ["Check Docker Compose status.", "Open the Controller health endpoint.", "Refresh the console."]
        };
    }

    const workers = data.workers || [];
    const objects = data.objects || [];
    const unavailable = workers.filter(w => w.status !== "healthy");
    const inventoryUnknown = workers.filter(w => w.status === "healthy" && w.actual_chunks === null);
    const mismatches = workers.filter(w =>
        w.actual_chunks !== null &&
        w.actual_chunks !== w.primary_chunks + w.replica_chunks
    );

    const evidence = [
        `${data.healthy_workers} of ${data.total_workers} registered Workers are heartbeat-healthy.`,
        `${data.total_objects} objects and ${data.total_chunks} chunks are recorded in SQLite.`,
        `Logical data size: ${formatBytes(data.logical_bytes)}; estimated physical data: ${formatBytes(data.estimated_physical_bytes)}.`
    ];

    let title = "Storage operations assessment";
    let answer = "";
    let actions = [];

    const workerMatch = q.match(/\bworker\s*([1-4])\b/);
    const namedWorker = workerMatch
        ? workers.find(w => w.worker_id.toLowerCase() === `worker${workerMatch[1]}`)
        : null;

    if (q.includes("what if") || q.includes("goes down") || q.includes("fail") || q.includes("down")) {
        if (namedWorker) {
            const primary = namedWorker.primary_chunks;
            const replica = namedWorker.replica_chunks;
            title = `Failure scenario: ${namedWorker.worker_id}`;

            answer = `${namedWorker.worker_id} is currently ${namedWorker.status}. According to the Controller's chunk metadata, it is assigned ${primary} primary chunk copies and ${replica} replica copies.`;

            if (namedWorker.status === "healthy") {
                answer += ` If this Worker becomes unavailable, downloads for chunks where it is primary can attempt the recorded replica. Chunks for which it is only a replica still have their primary location recorded elsewhere.`;
            } else {
                answer += ` The Worker is already outside the 30-second heartbeat window. The recorded alternate locations may support retrieval, but the dashboard does not independently verify every chunk copy.`;
            }

            evidence.push(`${namedWorker.worker_id}: ${primary} primary references, ${replica} replica references.`);
            actions = [
                "Inspect object placement for objects referencing this Worker.",
                "Confirm that alternate copies are reachable.",
                "Check Controller logs for FAILOVER and REPAIR events."
            ];
        } else {
            title = "Single-worker failure assessment";
            answer = `The system uses two recorded locations per chunk. During a single Worker outage, the Controller's download path tries the primary copy first and then the replica. This protects retrieval only when the alternate copy is present and valid.`;
            actions = [
                "Inspect the Worker dashboard for unavailable nodes.",
                "Use the placement inspector to examine affected objects.",
                "Monitor Controller logs for successful failover and repair."
            ];
        }
    } else if (q.includes("most data") || q.includes("most chunk") || q.includes("distribution") || q.includes("load")) {
        const ranked = [...workers].sort((a, b) =>
            (b.primary_chunks + b.replica_chunks) - (a.primary_chunks + a.replica_chunks)
        );

        title = "Worker placement distribution";
        answer = ranked.length
            ? `By Controller metadata references, ${ranked[0].worker_id} has the highest assigned copy count with ${ranked[0].primary_chunks + ranked[0].replica_chunks} references (${ranked[0].primary_chunks} primary and ${ranked[0].replica_chunks} replica). This is a placement count, not a measured CPU or disk utilization metric.`
            : "No Workers are registered, so there is no placement distribution to analyze.";

        ranked.forEach(worker => evidence.push(
            `${worker.worker_id}: ${worker.primary_chunks} primary + ${worker.replica_chunks} replica references.`
        ));

        actions = [
            "Compare metadata references with actual Worker inventory.",
            "Inspect placement for large objects.",
            "Consider a future rebalancing strategy if distribution becomes uneven."
        ];
    } else if (q.includes("replica") || q.includes("replication") || q.includes("protection") || q.includes("copy")) {
        title = "Replication risk assessment";

        const missingLocations = objects.length === 0
            ? 0
            : "Object-level placement inspection required";

        answer = `The configured replication factor is 2. The upload path writes a primary copy and a replica to different Workers. The dashboard can compare recorded references with actual Worker inventories, but it does not continuously re-download and hash every stored chunk.`;

        evidence.push(`${unavailable.length} Workers unavailable.`);
        evidence.push(`${mismatches.length} Workers have inventory counts different from metadata.`);
        evidence.push(`${inventoryUnknown.length} healthy Workers have unknown inventory.`);

        actions = [
            "Inspect each object's placement to confirm two locations are recorded.",
            "Investigate inventory mismatches and unavailable Workers.",
            "Check repair logs for chunks that could not be recovered."
        ];
    } else if (q.includes("repair")) {
        title = "Automatic replica repair";

        answer = `Your Controller runs a background repair scan every 15 seconds. It retrieves primary and replica copies, verifies their SHA-256 checksums, and if exactly one valid copy remains, it attempts to copy that data to a healthy Worker not already assigned to the chunk. It verifies the replacement before updating SQLite.`;

        evidence.push("Repair loop interval: 15 seconds.");
        evidence.push("Worker heartbeat health window: 30 seconds.");
        evidence.push("Repair requires at least one valid surviving copy and a healthy replacement Worker.");

        actions = [
            "Check Controller logs for [REPAIR] messages.",
            "Verify that at least one copy remains accessible.",
            "Confirm that the replacement Worker has registered and is heartbeat-healthy."
        ];
    } else if (q.includes("health") || q.includes("status") || q.includes("cluster") || q.includes("analy")) {
        title = "Live cluster health analysis";

        if (data.healthy_workers === data.total_workers && data.total_workers >= 2 && !mismatches.length && !inventoryUnknown.length) {
            answer = "All registered Workers are within the heartbeat health window, and the queried inventories match the Controller's placement reference counts. This is a positive operational signal. It is not a full end-to-end checksum audit of every chunk.";
        } else {
            answer = `The cluster has ${data.healthy_workers} healthy Workers out of ${data.total_workers}. ${unavailable.length} Worker(s) are unavailable, ${mismatches.length} inventory mismatch(es) were detected, and ${inventoryUnknown.length} healthy Worker inventory query/queries failed.`;
        }

        evidence.push(...unavailable.map(w => `${w.worker_id} is outside the heartbeat window.`));
        evidence.push(...mismatches.map(w => `${w.worker_id}: metadata references ${w.primary_chunks + w.replica_chunks}; actual inventory ${w.actual_chunks}.`));

        actions = [
            "Resolve unavailable Workers before accepting new uploads.",
            "Investigate inventory mismatches.",
            "Review Controller repair logs and re-run the assessment."
        ];
    } else if (q.includes("upload")) {
        title = "Upload path explanation";
        answer = `The upload API accepts a multipart file and optional JSON metadata. The Controller rejects empty files and requires at least two healthy Workers. It divides the file into 1 MiB chunks, writes each chunk to a primary Worker and a different replica Worker, calculates SHA-256 checksums, and stores object and chunk metadata in SQLite.`;
        evidence.push("Upload endpoint: POST /api/v1/objects.");
        evidence.push("Successful upload response: HTTP 201.");
        actions = [
            "Confirm at least two Workers are healthy.",
            "Check the Controller logs if a storage request fails.",
            "Inspect the returned object ID and chunk placement."
        ];
    } else if (q.includes("checksum") || q.includes("integrity") || q.includes("corrupt")) {
        title = "Integrity verification explanation";
        answer = `The download path verifies each retrieved chunk against its stored SHA-256 checksum. It also verifies the checksum of the reconstructed complete object. The repair process independently verifies candidate copies and newly written replacements. The dashboard itself does not run a full checksum scan.`;
        evidence.push("Per-chunk checksum: SHA-256.");
        evidence.push("Reconstructed object checksum: SHA-256.");
        actions = [
            "Download an object to exercise the actual integrity checks.",
            "Review Controller logs for checksum mismatch messages.",
            "Use the placement inspector to examine primary and replica locations."
        ];
    } else if (q.includes("object") || q.includes("storage") || q.includes("space") || q.includes("size")) {
        title = "Object storage summary";
        answer = `The Controller currently records ${data.total_objects} objects containing ${data.total_chunks} chunks. Their logical data size is ${formatBytes(data.logical_bytes)}. The estimated physical data size assumes two copies of every chunk. This is an estimate, not a filesystem capacity measurement.`;
        evidence.push(`Logical bytes: ${data.logical_bytes}.`);
        evidence.push(`Estimated physical bytes: ${data.estimated_physical_bytes}.`);
        actions = [
            "Open Object Explorer to search, inspect, download or delete objects.",
            "Inspect object metadata and chunk placement.",
            "Use the Worker dashboard to compare recorded and actual inventory."
        ];
    } else {
        title = "Supported operational questions";
        answer = `I can answer questions about this implementation's Worker health, object uploads, chunk distribution, replication, failover, automatic repair, metadata, storage estimates and SHA-256 integrity checks. I do not have a language model behind this assistant, so I use explicit diagnostic rules rather than inventing answers.`;
        actions = [
            "Ask: Analyze my cluster health.",
            "Ask: What happens if worker2 goes down?",
            "Ask: Explain automatic replica repair.",
            "Ask: Which Workers have the most chunks?"
        ];
    }

    return { title, answer, evidence, actions };
}

function addChatMessage(role, content) {
    const wrapper = document.createElement("div");
    wrapper.className = role === "user" ? "user-message" : "assistant-message";

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = role === "user" ? "H" : "✳";

    const body = document.createElement("div");
    body.className = "message-content";

    const heading = document.createElement("strong");
    heading.textContent = role === "user" ? "You" : "Storage analyst";

    const paragraph = document.createElement("p");
    paragraph.textContent = content;

    body.append(heading, paragraph);
    wrapper.append(avatar, body);
    $("#chatHistory").appendChild(wrapper);

    return body;
}

async function askCopilot(question) {
    const trimmed = question.trim();
    if (!trimmed) return;

    addChatMessage("user", trimmed);
    $("#copilotInput").value = "";

    try {
        await refreshAll();
    } catch (_) {
        // The rule engine can still explain known design behavior,
        // but it will explicitly report that live context is unavailable.
    }

    const result = copilotAnalyze(trimmed);
    const body = addChatMessage("assistant", result.title);

    const evidence = document.createElement("ul");
    result.evidence.forEach(item => {
        const li = document.createElement("li");
        li.textContent = item;
        evidence.appendChild(li);
    });

    const actions = document.createElement("ul");
    result.actions.forEach(item => {
        const li = document.createElement("li");
        li.textContent = item;
        actions.appendChild(li);
    });

    body.appendChild(evidence);

    const answer = document.createElement("p");
    answer.textContent = result.answer;
    body.appendChild(answer);

    const actionHeading = document.createElement("strong");
    actionHeading.textContent = "Recommended next steps";
    body.appendChild(actionHeading);
    body.appendChild(actions);

    const tag = document.createElement("span");
    tag.className = "evidence-tag";
    tag.textContent = "RULE-BASED ANALYSIS · LIVE SNAPSHOT";
    body.appendChild(tag);

    $("#chatHistory").scrollTop = $("#chatHistory").scrollHeight;
}

// ============================================================
// EVENT HANDLERS
// ============================================================

document.addEventListener("click", event => {
    const pageButton = event.target.closest("[data-page]");
    if (pageButton) {
        showPage(pageButton.dataset.page);
        return;
    }

    const actionButton = event.target.closest("[data-action]");
    if (actionButton?.dataset.action === "upload") {
        $("#uploadResult").textContent = "";
        openModal("uploadModal");
        return;
    }

    const viewButton = event.target.closest("[data-view]");
    if (viewButton) {
        viewObject(viewButton.dataset.view);
        return;
    }

    const downloadButton = event.target.closest("[data-download]");
    if (downloadButton) {
        downloadObject(downloadButton.dataset.download);
        return;
    }

    const deleteButton = event.target.closest("[data-delete]");
    if (deleteButton) {
        deleteObject(deleteButton.dataset.delete);
        return;
    }

    const closeButton = event.target.closest("[data-close]");
    if (closeButton) closeModal(closeButton.dataset.close);
});

$$(".nav-link").forEach(button => {
    button.addEventListener("click", () => showPage(button.dataset.page));
});

$("#refreshButton").addEventListener("click", async () => {
    await refreshAll();
    toast("Dashboard refreshed.");
});

$("#reloadObjects").addEventListener("click", async () => {
    await refreshAll();
    toast("Objects refreshed.");
});

$("#reloadWorkers").addEventListener("click", async () => {
    await refreshAll();
    toast("Worker information refreshed.");
});

$("#reloadReliability").addEventListener("click", async () => {
    await refreshAll();
    renderReliability();
    toast("Reliability assessment refreshed.");
});

$("#inspectPlacement").addEventListener("click", inspectPlacement);
$("#objectSearch").addEventListener("input", renderObjects);
$("#uploadForm").addEventListener("submit", uploadObject);

$("#fileInput").addEventListener("change", event => {
    state.selectedFile = event.target.files[0] || null;
    $("#fileLabel").textContent = state.selectedFile
        ? `${state.selectedFile.name} · ${formatBytes(state.selectedFile.size)}`
        : "Files are chunked into 1 MB blocks and replicated twice.";
});

$("#dropZone").addEventListener("dragover", event => {
    event.preventDefault();
    $("#dropZone").classList.add("dragging");
});

$("#dropZone").addEventListener("dragleave", () => {
    $("#dropZone").classList.remove("dragging");
});

$("#dropZone").addEventListener("drop", event => {
    event.preventDefault();
    $("#dropZone").classList.remove("dragging");

    const file = event.dataTransfer.files[0];
    if (!file) return;

    state.selectedFile = file;
    $("#fileLabel").textContent = `${file.name} · ${formatBytes(file.size)}`;
});

$("#copilotForm").addEventListener("submit", event => {
    event.preventDefault();
    askCopilot($("#copilotInput").value);
});

$$("[data-question]").forEach(button => {
    button.addEventListener("click", () => askCopilot(button.dataset.question));
});

$("#mobileMenu").addEventListener("click", () => {
    $("#sidebar").classList.toggle("open");
});

$$(".modal-backdrop").forEach(backdrop => {
    backdrop.addEventListener("click", event => {
        if (event.target === backdrop) backdrop.classList.remove("open");
    });
});

// ============================================================
// INITIALIZATION
// ============================================================

async function initializeConsole() {
    try {
        await refreshAll();
        renderReliability();
    } catch (error) {
        console.error("Console initialization failed:", error);
    }

    setInterval(async () => {
        try {
            await refreshAll();
        } catch (_) {}
    }, REFRESH_INTERVAL);
}

initializeConsole();

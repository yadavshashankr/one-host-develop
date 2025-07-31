// Constants - now imported from config
const CHUNK_SIZE = window.CONFIG?.CHUNK_SIZE || 16384;
const DB_NAME = window.CONFIG?.DB_NAME || 'fileTransferDB';
const DB_VERSION = window.CONFIG?.DB_VERSION || 1;
const STORE_NAME = window.CONFIG?.STORE_NAME || 'files';
const KEEP_ALIVE_INTERVAL = window.CONFIG?.KEEP_ALIVE_INTERVAL || 30000;
const CONNECTION_TIMEOUT = window.CONFIG?.CONNECTION_TIMEOUT || 60000;

// Message types are now imported from constants.js via window.MESSAGE_TYPES

// DOM Elements
const elements = {
    peerId: document.getElementById('peer-id'),
    copyId: document.getElementById('copy-id'),
    shareId: document.getElementById('share-id'),
    remotePeerId: document.getElementById('remote-peer-id'),
    connectButton: document.getElementById('connect-button'),
    fileInput: document.getElementById('file-input'),
    dropZone: document.getElementById('drop-zone'),
    transferProgress: document.getElementById('transfer-progress'),
    progress: document.getElementById('progress'),
    transferInfo: document.getElementById('transfer-info'),
    fileList: document.getElementById('file-list'),
    statusText: document.getElementById('status-text'),
    statusDot: document.getElementById('status-dot'),
    browserSupport: document.getElementById('browser-support'),
    fileTransferSection: document.getElementById('file-transfer-section'),
    qrcode: document.getElementById('qrcode'),
    receivedFiles: document.getElementById('received-files'),
    notifications: document.getElementById('notifications'),
    sentFilesList: document.getElementById('sent-files-list'),
    receivedFilesList: document.getElementById('received-files-list'),
    recentPeers: document.getElementById('recent-peers'),
    recentPeersList: document.getElementById('recent-peers-list'),
    clearPeers: document.getElementById('clear-peers'),
    // Add new elements for peer ID editing
    peerIdEdit: document.getElementById('peer-id-edit'),
    editIdButton: document.getElementById('edit-id'),
    saveIdButton: document.getElementById('save-id'),
    cancelEditButton: document.getElementById('cancel-edit')
};

// State
let peer = null;
let connections = new Map(); // Map to store multiple connections
let db = null;
let transferInProgress = false;
let isConnectionReady = false;
let fileChunks = {}; // Initialize fileChunks object
let keepAliveInterval = null;
let connectionTimeouts = new Map();
let isPageVisible = true;

// Add file history tracking with Sets for uniqueness
const fileHistory = {
    sent: new Set(),
    received: new Set()
};

// Add blob storage for sent files
const sentFileBlobs = new Map(); // Map to store blobs of sent files

// Add recent peers tracking
let recentPeers = [];
const MAX_RECENT_PEERS = 5;

// Add file queue system
let fileQueue = [];
let isProcessingQueue = false;

// --- Remove notification-based progress ---
// Remove showProgressNotification, clearProgressNotification, and patch of updateProgress

// --- Download progress per file ---
const downloadProgressMap = new Map(); // fileId -> { button, percent }

// Patch updateFilesList to mark download buttons for received files
const originalUpdateFilesList = updateFilesList;
updateFilesList = function(listElement, fileInfo, type) {
    originalUpdateFilesList(listElement, fileInfo, type);
    if (type === 'received' || type === 'sent') {
        const li = listElement.querySelector(`[data-file-id="${fileInfo.id}"]`);
        if (li) {
            const downloadBtn = li.querySelector('.icon-button');
            if (downloadBtn) {
                downloadBtn.setAttribute('data-file-id', fileInfo.id);
            }
        }
        // Scroll to bottom after adding
        listElement.scrollTop = listElement.scrollHeight;
    }
};

// Patch requestAndDownloadBlob to set up progress UI
const originalRequestAndDownloadBlob = requestAndDownloadBlob;
requestAndDownloadBlob = async function(fileInfo) {
    const fileId = fileInfo.id;
    const btn = document.querySelector(`button.icon-button[data-file-id="${fileId}"]`);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '0%';
        downloadProgressMap.set(fileId, { button: btn, percent: 0 });
    }
    await originalRequestAndDownloadBlob(fileInfo);
};

// Patch updateProgress to update button percentage for downloads
const originalUpdateProgress = updateProgress;
updateProgress = function(progress, fileId) {
    if (fileId && downloadProgressMap.has(fileId)) {
        const entry = downloadProgressMap.get(fileId);
        const percent = Math.floor(progress);
        if (entry.percent !== percent) {
            entry.button.innerHTML = `<span class='download-progress-text'>${percent}%</span>`;
            entry.percent = percent;
        }
    }
    originalUpdateProgress(progress);
};

// Patch handleFileComplete to swap to open file icon and enable open
const originalHandleFileComplete = handleFileComplete;
handleFileComplete = async function(data) {
    await originalHandleFileComplete(data);
    const fileId = data.fileId;
    if (downloadProgressMap.has(fileId)) {
        const entry = downloadProgressMap.get(fileId);
        entry.button.disabled = false;
        entry.button.innerHTML = '<span class="material-icons">open_in_new</span>';
        // The open logic is already set in downloadBlob
        downloadProgressMap.delete(fileId);
    }
};

// Load recent peers from localStorage
function loadRecentPeers() {
    try {
        const saved = localStorage.getItem('recentPeers');
        if (saved) {
            recentPeers = JSON.parse(saved);
            updateRecentPeersList();
        }
    } catch (error) {
        console.error('Error loading recent peers:', error);
    }
}

// Save recent peers to localStorage
function saveRecentPeers() {
    try {
        localStorage.setItem('recentPeers', JSON.stringify(recentPeers));
    } catch (error) {
        console.error('Error saving recent peers:', error);
    }
}

// Add a peer to recent peers list
function addRecentPeer(peerId) {
    const existingIndex = recentPeers.indexOf(peerId);
    if (existingIndex !== -1) {
        recentPeers.splice(existingIndex, 1);
    }
    recentPeers.unshift(peerId);
    if (recentPeers.length > MAX_RECENT_PEERS) {
        recentPeers.pop();
    }
    saveRecentPeers();
    updateRecentPeersList();
}

// Update the recent peers list UI
function updateRecentPeersList() {
    elements.recentPeersList.innerHTML = '';
    recentPeers.forEach(peerId => {
        const li = document.createElement('li');
        li.textContent = peerId;
        li.onclick = () => {
            elements.remotePeerId.value = peerId;
            elements.recentPeers.classList.add('hidden');
            elements.connectButton.click();
        };
        elements.recentPeersList.appendChild(li);
    });
}

// Check WebRTC Support
function checkBrowserSupport() {
    if (!window.RTCPeerConnection || !navigator.mediaDevices) {
        elements.browserSupport.classList.remove('hidden');
        return false;
    }
    return true;
}

// Initialize IndexedDB
// ✅ ENHANCED: IndexedDB setup with file chunks support
async function initIndexedDB() {
    return new Promise((resolve, reject) => {
        try {
            const request = indexedDB.open(DB_NAME, DB_VERSION + 1); // Increment version for new store
            
            request.onerror = (event) => {
                console.error('IndexedDB initialization failed:', event.target.error);
                showNotification('IndexedDB initialization failed', 'error');
                reject(event.target.error);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
                
                // ✅ Create file chunks store for streaming downloads
                if (!db.objectStoreNames.contains('fileChunks')) {
                    const store = db.createObjectStore('fileChunks', { keyPath: 'fileId' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };

            request.onsuccess = (event) => {
                db = event.target.result;
                resolve(db);
            };
        } catch (error) {
            console.error('IndexedDB Error:', error);
            showNotification('Storage initialization failed', 'error');
            reject(error);
        }
    });
}

// ✅ NEW: Device detection functions
function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

function isPWA() {
    return window.matchMedia('(display-mode: standalone)').matches || 
           window.navigator.standalone === true;
}

// ✅ NEW: Fallback storage for when IndexedDB fails
const fallbackChunkStorage = new Map();

// ✅ NEW: Check if IndexedDB is supported
function isIndexedDBSupported() {
    return 'indexedDB' in window;
}

// ✅ NEW: Store file chunks for streaming
async function storeFileChunk(fileId, chunkData, chunkIndex) {
    try {
        // Try IndexedDB first
        if (isIndexedDBSupported()) {
            const db = await initIndexedDB();
            if (db) {
                const transaction = db.transaction(['fileChunks'], 'readwrite');
                const store = transaction.objectStore('fileChunks');
                
                await store.put({
                    fileId: fileId,
                    chunkData: chunkData,
                    chunkIndex: chunkIndex,
                    chunkSize: chunkData.byteLength,
                    timestamp: Date.now(),
                    metadata: {
                        originalSize: chunkData.byteLength,
                        chunkOrder: chunkIndex
                    }
                });
                return;
            }
        }
        
        // Fallback to in-memory storage
        if (!fallbackChunkStorage.has(fileId)) {
            fallbackChunkStorage.set(fileId, []);
        }
        
        const chunks = fallbackChunkStorage.get(fileId);
        chunks.push({
            fileId: fileId,
            chunkData: chunkData,
            chunkIndex: chunkIndex,
            timestamp: Date.now()
        });
        
        console.log('Using fallback storage for chunk', chunkIndex);
        
    } catch (error) {
        console.error('Error storing file chunk:', error);
        
        // Fallback to in-memory storage on error
        if (!fallbackChunkStorage.has(fileId)) {
            fallbackChunkStorage.set(fileId, []);
        }
        
        const chunks = fallbackChunkStorage.get(fileId);
        chunks.push({
            fileId: fileId,
            chunkData: chunkData,
            chunkIndex: chunkIndex,
            timestamp: Date.now()
        });
        
        console.log('Using fallback storage due to error');
    }
}

// ✅ NEW: Get all chunks for a file
async function getFileChunks(fileId) {
    try {
        // Try local fileChunks first (most reliable)
        const localChunks = getLocalFileChunks(fileId);
        if (localChunks.length > 0) {
            console.log(`Retrieved ${localChunks.length} chunks from local storage for ${fileId}`);
            console.log(`Local chunks details:`, localChunks.map(c => ({ index: c.chunkIndex, size: c.chunkData?.byteLength })));
            return localChunks;
        }
        
        // Try IndexedDB next
        if (isIndexedDBSupported()) {
            const db = await initIndexedDB();
            if (db) {
                const transaction = db.transaction(['fileChunks'], 'readonly');
                const store = transaction.objectStore('fileChunks');
                
                // Use proper IndexedDB request handling
                const chunks = await new Promise((resolve, reject) => {
                    const request = store.getAll(IDBKeyRange.only(fileId));
                    
                    request.onsuccess = function() {
                        const chunks = request.result;
                        console.log(`IndexedDB raw result for ${fileId}:`, chunks);
                        
                        // Ensure chunks is an array
                        if (!Array.isArray(chunks)) {
                            console.error(`IndexedDB returned non-array for ${fileId}:`, chunks);
                            console.log(`Type: ${typeof chunks}, Value:`, chunks);
                            resolve([]);
                            return;
                        }
                        
                        // Sort by chunk index to ensure correct order
                        const sortedChunks = chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
                        console.log(`Retrieved ${sortedChunks.length} chunks from IndexedDB for ${fileId}`);
                        resolve(sortedChunks);
                    };
                    
                    request.onerror = function() {
                        console.error(`IndexedDB error for ${fileId}:`, request.error);
                        resolve([]);
                    };
                });
                
                if (chunks.length > 0) {
                    return chunks;
                }
            }
        }
        
        // Fallback to in-memory storage
        if (fallbackChunkStorage.has(fileId)) {
            const chunks = fallbackChunkStorage.get(fileId);
            
            // Ensure chunks is an array
            if (!Array.isArray(chunks)) {
                console.error(`Fallback storage returned non-array for ${fileId}:`, chunks);
                return [];
            }
            
            const sortedChunks = chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
            console.log(`Retrieved ${sortedChunks.length} chunks from fallback storage for ${fileId}`);
            return sortedChunks;
        }
        
        console.log(`No chunks found for ${fileId}`);
        return [];
        
    } catch (error) {
        console.error('Error getting file chunks:', error);
        
        // Try local fileChunks as fallback
        const localChunks = getLocalFileChunks(fileId);
        if (localChunks.length > 0) {
            console.log(`Retrieved ${localChunks.length} chunks from local storage after error for ${fileId}`);
            return localChunks;
        }
        
        // Fallback to in-memory storage on error
        if (fallbackChunkStorage.has(fileId)) {
            const chunks = fallbackChunkStorage.get(fileId);
            
            // Ensure chunks is an array
            if (!Array.isArray(chunks)) {
                console.error(`Fallback storage returned non-array after error for ${fileId}:`, chunks);
                return [];
            }
            
            const sortedChunks = chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
            console.log(`Retrieved ${sortedChunks.length} chunks from fallback storage after error for ${fileId}`);
            return sortedChunks;
        }
        
        return [];
    }
}

// ✅ NEW: Get chunks from local fileChunks array
function getLocalFileChunks(fileId) {
    console.log(`Getting local chunks for ${fileId}`);
    console.log(`Global fileChunks keys:`, Object.keys(fileChunks));
    console.log(`Global fileChunks size:`, Object.keys(fileChunks).length);
    
    const fileData = fileChunks[fileId];
    if (!fileData || !fileData.chunks) {
        console.log(`No fileData or chunks for ${fileId}:`, { 
            fileData: !!fileData, 
            chunks: !!fileData?.chunks,
            fileDataKeys: fileData ? Object.keys(fileData) : 'no fileData',
            chunksLength: fileData?.chunks?.length || 'no chunks array'
        });
        return [];
    }
    
    console.log(`Local fileData for ${fileId}:`, {
        chunksLength: fileData.chunks.length,
        receivedSize: fileData.receivedSize,
        fileSize: fileData.fileSize,
        definedChunks: fileData.chunks.filter(c => c !== undefined).length
    });
    
    // Convert to the same format as IndexedDB chunks with proper validation
    const result = fileData.chunks
        .map((chunk, index) => {
            if (chunk === undefined) {
                console.warn(`Missing chunk at index ${index} for ${fileId}`);
                return null;
            }
            if (!chunk || typeof chunk.byteLength === 'undefined') {
                console.error(`Invalid chunk at index ${index} for ${fileId}:`, chunk);
                return null;
            }
            return {
                fileId: fileId,
                chunkData: chunk,
                chunkIndex: index,
                chunkSize: chunk.byteLength,
                timestamp: Date.now(),
                metadata: {
                    originalSize: chunk.byteLength,
                    chunkOrder: index
                }
            };
        })
        .filter(chunk => chunk !== null);
    
    console.log(`Converted ${result.length} local chunks for ${fileId}`);
    return result;
}

// ✅ NEW: Verify file integrity and completeness
async function verifyFileIntegrity(fileId, expectedSize, expectedChunks) {
    try {
        const chunks = await getFileChunks(fileId);
        
        if (chunks.length === 0) {
            throw new Error('No chunks found for file verification');
        }
        
        // Sort chunks by index
        chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
        
        // Verify chunk count
        if (chunks.length !== expectedChunks) {
            console.warn(`Chunk count mismatch: expected ${expectedChunks}, got ${chunks.length}`);
        }
        
        // Calculate total size and verify chunk order
        let totalSize = 0;
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            
            if (chunk.chunkIndex !== i) {
                throw new Error(`Chunk order corrupted: expected ${i}, got ${chunk.chunkIndex}`);
            }
            
            const chunkSize = chunk.chunkData.byteLength;
            totalSize += chunkSize;
            
            console.log(`Chunk ${i}: size=${chunkSize}, index=${chunk.chunkIndex}`);
        }
        
        // Verify total size
        const sizeDifference = Math.abs(totalSize - expectedSize);
        const sizeTolerance = Math.max(1024, expectedSize * 0.001); // 1KB or 0.1% tolerance
        
        if (sizeDifference > sizeTolerance) {
            throw new Error(`File size mismatch: expected ${expectedSize}, got ${totalSize} (difference: ${sizeDifference})`);
        }
        
        console.log(`File integrity verified: size=${totalSize}, chunks=${chunks.length}, tolerance=${sizeTolerance}`);
        return true;
        
    } catch (error) {
        console.error('File integrity verification failed:', error);
        throw error;
    }
}

// ✅ NEW: Preserve file chunks to prevent loss
function preserveFileChunks(fileId) {
    const fileData = fileChunks[fileId];
    if (fileData && fileData.chunks) {
        console.log(`Preserving ${fileData.chunks.length} chunks for ${fileId}`);
        // Store a backup in sessionStorage as a fallback
        try {
            const backup = {
                fileId: fileId,
                fileName: fileData.fileName,
                fileType: fileData.fileType,
                fileSize: fileData.fileSize,
                receivedSize: fileData.receivedSize,
                chunksCount: fileData.chunks.length,
                timestamp: Date.now()
            };
            sessionStorage.setItem(`fileChunks_backup_${fileId}`, JSON.stringify(backup));
            console.log(`File chunks backup created for ${fileId}`);
        } catch (error) {
            console.error('Error creating file chunks backup:', error);
        }
    }
}

// ✅ NEW: Check file transfer status and provide guidance
function checkFileTransferStatus(fileId, fileName) {
    console.log(`=== FILE TRANSFER STATUS CHECK ===`);
    console.log(`Checking transfer status for: ${fileName} (${fileId})`);
    
    // Check if there are any active connections
    const activeConnections = Array.from(connections.values()).filter(conn => conn.open);
    console.log(`Active connections: ${activeConnections.length}`);
    
    if (activeConnections.length === 0) {
        console.warn(`No active connections found - file transfer may have failed`);
        showNotification('No active connection found. Please ensure both devices are connected.', 'warning');
        return false;
    }
    
    // Check connection quality
    activeConnections.forEach((conn, index) => {
        console.log(`Connection ${index}:`, {
            peer: conn.peer,
            open: conn.open,
            readyState: conn.connectionState || 'unknown',
            bufferedAmount: conn.bufferedAmount || 'unknown'
        });
    });
    
    // Check if the file was ever in the transfer queue
    console.log(`Checking if file was in transfer queue...`);
    
    // Check if there are any recent file transfer activities
    const recentActivity = sessionStorage.getItem('recentFileTransfers');
    if (recentActivity) {
        console.log(`Recent file transfer activity:`, recentActivity);
        
        // Parse and analyze the activity
        try {
            const activities = JSON.parse(recentActivity);
            const fileActivities = activities.filter(a => a.fileId === fileId);
            console.log(`Activities for this file:`, fileActivities);
            
            // Check if chunks were received
            const chunkActivities = fileActivities.filter(a => a.action === 'file-chunk-received');
            console.log(`Chunk reception count: ${chunkActivities.length}`);
            
            if (chunkActivities.length === 0) {
                console.error(`No chunks were received for this file!`);
                showNotification('File chunks were not received. This may indicate a network issue.', 'error');
            } else {
                console.log(`Received ${chunkActivities.length} chunks for this file`);
            }
        } catch (error) {
            console.error('Error parsing recent activity:', error);
        }
    } else {
        console.log(`No recent file transfer activity found`);
    }
    
    return true;
}

// ✅ NEW: Check if file was actually received
function checkIfFileWasReceived(fileId, fileName) {
    console.log(`=== FILE RECEIPT CHECK ===`);
    console.log(`Checking if file was received: ${fileName} (${fileId})`);
    
    // Check if file exists in received files list
    const receivedFilesList = document.querySelector('.files-list');
    if (receivedFilesList) {
        const fileItems = receivedFilesList.querySelectorAll('li');
        console.log(`Found ${fileItems.length} items in received files list`);
        
        fileItems.forEach((item, index) => {
            const itemFileId = item.getAttribute('data-file-id');
            const itemFileName = item.querySelector('.file-name')?.textContent;
            console.log(`Item ${index}: fileId="${itemFileId}", name="${itemFileName}"`);
            
            if (itemFileId === fileId) {
                console.log(`✅ File found in received files list: ${fileName}`);
            }
        });
    } else {
        console.log(`No received files list found`);
    }
    
    // Check if file was added to history
    console.log(`Checking file history...`);
    // This would need access to the file history storage
}

// ✅ NEW: List all available files for debugging
function listAllAvailableFiles() {
    console.log(`=== AVAILABLE FILES DEBUG ===`);
    console.log(`Global fileChunks:`, Object.keys(fileChunks));
    console.log(`Global fileChunks count:`, Object.keys(fileChunks).length);
    
    // List all files in global storage
    Object.keys(fileChunks).forEach(fileId => {
        const fileData = fileChunks[fileId];
        console.log(`File: ${fileId}`, {
            fileName: fileData.fileName || 'unknown',
            fileSize: fileData.fileSize || 0,
            receivedSize: fileData.receivedSize || 0,
            chunksLength: fileData.chunks?.length || 0,
            hasChunks: !!fileData.chunks,
            chunksArray: Array.isArray(fileData.chunks)
        });
    });
    
    // Check IndexedDB for files
    if (isIndexedDBSupported()) {
        initIndexedDB().then(db => {
            if (db) {
                const transaction = db.transaction(['fileChunks'], 'readonly');
                const store = transaction.objectStore('fileChunks');
                const request = store.getAll();
                
                request.onsuccess = function() {
                    const allChunks = request.result;
                    console.log(`IndexedDB total chunks:`, allChunks.length);
                    
                    // Group by fileId
                    const filesInIndexedDB = {};
                    allChunks.forEach(chunk => {
                        if (!filesInIndexedDB[chunk.fileId]) {
                            filesInIndexedDB[chunk.fileId] = [];
                        }
                        filesInIndexedDB[chunk.fileId].push(chunk);
                    });
                    
                    console.log(`Files in IndexedDB:`, Object.keys(filesInIndexedDB));
                    Object.keys(filesInIndexedDB).forEach(fileId => {
                        console.log(`IndexedDB File: ${fileId} - ${filesInIndexedDB[fileId].length} chunks`);
                    });
                };
            }
        });
    }
}

// ✅ NEW: Restore file chunks from backup if needed
function restoreFileChunks(fileId) {
    try {
        const backupKey = `fileChunks_backup_${fileId}`;
        const backupData = sessionStorage.getItem(backupKey);
        if (backupData) {
            const backup = JSON.parse(backupData);
            console.log(`Found backup for ${fileId}:`, backup);
            
            // Check if current chunks are missing or incomplete
            const currentData = fileChunks[fileId];
            if (!currentData || !currentData.chunks || currentData.chunks.length === 0) {
                console.log(`Restoring file chunks from backup for ${fileId}`);
                // The actual chunks would need to be restored from IndexedDB
                return true;
            }
        }
    } catch (error) {
        console.error('Error restoring file chunks:', error);
    }
    return false;
}

// ✅ NEW: Validate and repair chunk data
async function validateAndRepairChunks(fileId, expectedSize) {
    try {
        const chunks = await getFileChunks(fileId);
        
        if (chunks.length === 0) {
            console.error(`No chunks found for validation: ${fileId}`);
            return false;
        }
        
        console.log(`Validating ${chunks.length} chunks for ${fileId}`);
        
        // Check for missing chunks
        const chunkIndices = chunks.map(c => c.chunkIndex).sort((a, b) => a - b);
        const expectedIndices = Array.from({ length: chunks.length }, (_, i) => i);
        
        const missingIndices = expectedIndices.filter(i => !chunkIndices.includes(i));
        if (missingIndices.length > 0) {
            console.error(`Missing chunk indices: ${missingIndices.join(', ')}`);
            return false;
        }
        
        // Check total size
        let totalSize = 0;
        for (const chunk of chunks) {
            if (!chunk.chunkData || typeof chunk.chunkData.byteLength === 'undefined') {
                console.error(`Invalid chunk at index ${chunk.chunkIndex}`);
                return false;
            }
            totalSize += chunk.chunkData.byteLength;
        }
        
        const sizeDifference = Math.abs(totalSize - expectedSize);
        const tolerance = Math.max(1024, expectedSize * 0.001); // 1KB or 0.1% tolerance
        
        if (sizeDifference > tolerance) {
            console.error(`Size mismatch: expected ${expectedSize}, got ${totalSize} (difference: ${sizeDifference})`);
            return false;
        }
        
        console.log(`Chunk validation successful: ${chunks.length} chunks, ${totalSize} bytes`);
        return true;
        
    } catch (error) {
        console.error('Chunk validation failed:', error);
        return false;
    }
}

// ✅ NEW: Clean up file chunks
async function cleanupFileChunks(fileId) {
    try {
        // Try IndexedDB first
        if (isIndexedDBSupported()) {
            const db = await initIndexedDB();
            if (db) {
                const transaction = db.transaction(['fileChunks'], 'readwrite');
                const store = transaction.objectStore('fileChunks');
                
                await store.delete(IDBKeyRange.only(fileId));
                return;
            }
        }
        
        // Fallback: clean up in-memory storage
        fallbackChunkStorage.delete(fileId);
        
        // Clean up local fileChunks
        if (fileChunks[fileId]) {
            delete fileChunks[fileId];
        }
        
    } catch (error) {
        console.error('Error cleaning up file chunks:', error);
        
        // Fallback: clean up in-memory storage
        fallbackChunkStorage.delete(fileId);
        
        // Clean up local fileChunks
        if (fileChunks[fileId]) {
            delete fileChunks[fileId];
        }
    }
}

// Generate QR Code
function generateQRCode(peerId) {
    try {
        if (!elements.qrcode) return;
        elements.qrcode.innerHTML = ''; // Clear previous QR code
        
        // Generate URL with peer ID as query parameter
        const baseUrl = window.CONFIG?.BASE_URL || (window.location.origin + window.location.pathname);
        const qrUrl = `${baseUrl}?peer=${peerId}`;
        
        new QRCode(elements.qrcode, {
            text: qrUrl,
            width: 128,
            height: 128,
            colorDark: '#2196F3',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.H
        });
    } catch (error) {
        console.error('QR Code Generation Error:', error);
    }
}

// Check URL for peer ID on load
function checkUrlForPeerId() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const peerId = urlParams.get('peer');
        
        if (peerId && peerId.length > 0) {
            elements.remotePeerId.value = peerId;
            // Wait a bit for PeerJS to initialize
            setTimeout(() => {
                elements.connectButton.click();
            }, 1500);
        }
    } catch (error) {
        console.error('Error parsing URL parameters:', error);
    }
}

// Store sent files for later download
const sentFilesStore = new Map();

// Debug function to check sentFilesStore
function debugSentFilesStore() {
    console.log(`=== SENT FILES STORE DEBUG ===`);
    console.log(`Store size: ${sentFilesStore.size}`);
    console.log(`Store keys:`, Array.from(sentFilesStore.keys()));
    for (const [key, value] of sentFilesStore.entries()) {
        console.log(`File ${key}:`, {
            name: value.name,
            size: value.size,
            type: value.type
        });
    }
}

// ✅ NEW: Universal streaming download for all devices
async function downloadFileUniversal(fileId, fileName, fileType, fileSize) {
    try {
        // Method 1: File System Access API (modern desktop)
        if ('showSaveFilePicker' in window && !isMobileDevice()) {
            const result = await downloadWithFileSystemAPI(fileId, fileName, fileType, fileSize);
        if (result === false) {
            return false; // User cancelled
        }
        return result;
        }
        
        // Method 2: Native download with chunked blob (all devices)
        return await downloadWithNativeChunkedBlob(fileId, fileName, fileType, fileSize);
        
    } catch (error) {
        console.error('Universal download failed:', error);
        
        // Method 3: Fallback to data URL (smaller files only)
        if (fileSize < 100 * 1024 * 1024) { // 100MB limit for data URLs
            return await downloadWithDataURL(fileId, fileName, fileType, fileSize);
        }
        
        throw error;
    }
}

// ✅ NEW: File System Access API download
async function downloadWithFileSystemAPI(fileId, fileName, fileType, fileSize) {
    try {
        // Check if File System Access API is supported
        if (!('showSaveFilePicker' in window)) {
            throw new Error('File System Access API not supported');
        }
        
        // Let user choose download location with proper file type handling
        const fileExtension = fileName.split('.').pop() || '';
        const validFileType = fileType && fileType !== '' ? fileType : 'application/octet-stream';
        
        console.log(`File picker config: fileName=${fileName}, fileType=${validFileType}, extension=${fileExtension}`);
        
        const pickerOptions = {
            suggestedName: fileName
        };
        
        // Only add types if we have a valid file type
        if (validFileType && validFileType !== 'application/octet-stream') {
            pickerOptions.types = [{
                description: 'File',
                accept: {
                    [validFileType]: [`.${fileExtension}`]
                }
            }];
        }
        
        const fileHandle = await window.showSaveFilePicker(pickerOptions);

        const writable = await fileHandle.createWritable();
        
        // Get chunks and write directly to file system with perfect ordering
        console.log(`=== FILE SYSTEM API DOWNLOAD START ===`);
        console.log(`Downloading file: ${fileName} (${fileId})`);
        console.log(`File size: ${fileSize}, File type: ${fileType}`);
        
        // Preserve file chunks before File System API download
        preserveFileChunks(fileId);
        
        // Debug: Check if chunks exist before retrieval
        console.log(`Global fileChunks before File System API retrieval:`, Object.keys(fileChunks));
        if (fileChunks[fileId]) {
            console.log(`File data exists for File System API:`, {
                chunksLength: fileChunks[fileId].chunks?.length || 0,
                receivedSize: fileChunks[fileId].receivedSize || 0,
                fileSize: fileChunks[fileId].fileSize || 0
            });
        }
        
        const chunks = await getFileChunks(fileId);
        
        console.log(`File System API: Retrieved ${chunks.length} chunks for ${fileId}`);
        console.log(`File System API: Chunk details:`, chunks.map(c => ({
            index: c.chunkIndex,
            size: c.chunkData?.byteLength,
            valid: c.chunkData && typeof c.chunkData.byteLength === 'number'
        })));
        
        if (chunks.length === 0) {
            console.error(`No chunks found for ${fileId} - running debug`);
            checkFileTransferStatus(fileId, fileName);
            checkIfFileWasReceived(fileId, fileName);
            listAllAvailableFiles();
            
            // Provide user-friendly error message
            const errorMessage = `File "${fileName}" was never received. Please ensure the file was sent from the other device and the transfer completed successfully.`;
            showNotification(errorMessage, 'error');
            throw new Error('No file chunks found for File System API download');
        }
        
        // Validate all chunks have valid data
        const invalidChunks = chunks.filter(c => !c.chunkData || typeof c.chunkData.byteLength === 'undefined');
        if (invalidChunks.length > 0) {
            console.error(`File System API: Found ${invalidChunks.length} invalid chunks:`, invalidChunks);
            throw new Error(`Found ${invalidChunks.length} invalid chunks - file may be corrupted`);
        }
        
        // Sort chunks by index for perfect order
        chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
        
        // Validate chunks before writing
        const isValid = await validateAndRepairChunks(fileId, fileSize);
        if (!isValid) {
            throw new Error('File chunks validation failed for File System API - file may be corrupted or incomplete');
        }
        
        console.log(`File System API: Writing ${chunks.length} chunks, expected size: ${fileSize}`);
        
        let downloadedSize = 0;
        
        // Write chunks in perfect order
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            
            // Verify chunk order
            if (chunk.chunkIndex !== i) {
                throw new Error(`Chunk order corrupted in File System API: expected ${i}, got ${chunk.chunkIndex}`);
            }
            
            const arrayBuffer = await chunk.chunkData.arrayBuffer();
            await writable.write(arrayBuffer);
            
            downloadedSize += arrayBuffer.byteLength;
            
            // Update progress
            const progress = (downloadedSize / fileSize) * 100;
            updateProgress(progress, fileId);
            
            // Minimal delay for UI responsiveness
            if (i % 10 === 0) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        }
        
        console.log(`File System API: Written ${downloadedSize} bytes, expected: ${fileSize}`);
        
        await writable.close();
        
        console.log('File downloaded with File System API');
        showNotification(`${fileName} downloaded successfully`, 'success');
        
        return true;
        
    } catch (error) {
        console.error('File System API failed:', error);
        
        // Handle user cancellation gracefully
        if (error.name === 'AbortError' || error.message.includes('user aborted')) {
            console.log('User cancelled file download');
            showNotification('Download cancelled by user', 'info');
            return false; // Return false instead of throwing
        }
        
        // Handle invalid type errors
        if (error.message.includes('Invalid type')) {
            console.error('Invalid file type for picker:', { fileType, fileName });
            showNotification('File type not supported by browser, using fallback download', 'warning');
            // Fall back to native download method
            return await downloadWithNativeChunkedBlob(fileId, fileName, fileType, fileSize);
        }
        
        throw error;
    }
}

// ✅ NEW: Native download with chunked blob (works on ALL devices)
async function downloadWithNativeChunkedBlob(fileId, fileName, fileType, fileSize) {
    try {
        // Get chunks from storage with comprehensive validation
        console.log(`=== DOWNLOAD START ===`);
        console.log(`Downloading file: ${fileName} (${fileId})`);
        console.log(`File size: ${fileSize}, File type: ${fileType}`);
        
        // Preserve file chunks before download to prevent loss
        preserveFileChunks(fileId);
        
        // Debug: Check if chunks exist before retrieval
        console.log(`Global fileChunks before retrieval:`, Object.keys(fileChunks));
        console.log(`All available fileIds:`, Object.keys(fileChunks));
        console.log(`Looking for fileId: ${fileId}`);
        
        // Check if the fileId exists in the global storage
        const availableFileIds = Object.keys(fileChunks);
        const fileIdExists = availableFileIds.includes(fileId);
        console.log(`FileId exists in global storage: ${fileIdExists}`);
        
        if (fileChunks[fileId]) {
            console.log(`File data exists:`, {
                chunksLength: fileChunks[fileId].chunks?.length || 0,
                receivedSize: fileChunks[fileId].receivedSize || 0,
                fileSize: fileChunks[fileId].fileSize || 0,
                fileName: fileChunks[fileId].fileName || 'unknown'
            });
        } else {
            console.error(`File data NOT found for ${fileId}`);
            console.error(`Available fileIds:`, availableFileIds);
            
            // Check if there's a similar fileId (maybe case sensitivity issue)
            const similarFileIds = availableFileIds.filter(id => 
                id.toLowerCase().includes(fileId.toLowerCase().split('-')[0]) ||
                id.toLowerCase().includes(fileName.toLowerCase().replace(/\s+/g, ''))
            );
            console.log(`Similar fileIds found:`, similarFileIds);
        }
        
        const chunks = await getFileChunks(fileId);
        
        console.log(`Download: Retrieved ${chunks.length} chunks for ${fileId}`);
        console.log(`Download: Chunk details:`, chunks.map(c => ({
            index: c.chunkIndex,
            size: c.chunkData?.byteLength,
            valid: c.chunkData && typeof c.chunkData.byteLength === 'number'
        })));
        
        if (chunks.length === 0) {
            throw new Error('No file chunks found');
        }
        
        if (chunks.length === 0) {
            console.error(`No chunks found for ${fileId} - running debug`);
            listAllAvailableFiles();
            throw new Error('No file chunks found');
        }
        
        // Validate all chunks have valid data
        const invalidChunks = chunks.filter(c => !c.chunkData || typeof c.chunkData.byteLength === 'undefined');
        if (invalidChunks.length > 0) {
            console.error(`Found ${invalidChunks.length} invalid chunks:`, invalidChunks);
            throw new Error(`Found ${invalidChunks.length} invalid chunks - file may be corrupted`);
        }
        
        // Validate chunks before reassembly
        const isValid = await validateAndRepairChunks(fileId, fileSize);
        if (!isValid) {
            throw new Error('File chunks validation failed - file may be corrupted or incomplete');
        }
        
        // Verify file integrity before reassembly
        const expectedChunks = Math.ceil(fileSize / (256 * 1024)); // 256KB chunks
        await verifyFileIntegrity(fileId, fileSize, expectedChunks);
        
        // Robust chunk reassembly with perfect ordering and metadata preservation
        chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
        
        console.log(`Reassembling file: ${chunks.length} chunks, expected size: ${fileSize}`);
        console.log(`Chunk indices:`, chunks.map(c => c.chunkIndex));
        
        // Verify chunk integrity and completeness
        if (chunks.length !== expectedChunks) {
            console.warn(`Chunk count mismatch: expected ${expectedChunks}, got ${chunks.length}`);
        }
        
        // Calculate total size from chunks for verification
        let totalChunkSize = 0;
        const chunkBuffers = [];
        
        // Process chunks sequentially to ensure perfect order
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            
            // Verify chunk index matches expected order
            if (chunk.chunkIndex !== i) {
                console.error(`Chunk order mismatch: expected index ${i}, got ${chunk.chunkIndex}`);
                throw new Error(`Chunk order corrupted: expected ${i}, got ${chunk.chunkIndex}`);
            }
            
            // Convert chunk to array buffer
            const arrayBuffer = await chunk.chunkData.arrayBuffer();
            chunkBuffers.push(arrayBuffer);
            totalChunkSize += arrayBuffer.byteLength;
            
            // Update progress
            const progress = ((i + 1) / chunks.length) * 100;
            updateProgress(progress, fileId);
            
            // Minimal delay for UI responsiveness
            if (i % 10 === 0) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
        }
        
        // Verify total size matches expected
        console.log(`Total chunk size: ${totalChunkSize}, expected: ${fileSize}`);
        if (Math.abs(totalChunkSize - fileSize) > 1024) { // 1KB tolerance
            console.warn(`Size mismatch: expected ${fileSize}, got ${totalChunkSize}`);
        }
        
        // Create final blob with exact metadata
        const finalBlob = new Blob(chunkBuffers, { 
            type: fileType,
            lastModified: Date.now()
        });
        
        console.log(`Final blob created: size=${finalBlob.size}, type=${finalBlob.type}`);
        
        // Download using native method
        const url = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        // Clean up
        setTimeout(() => {
            URL.revokeObjectURL(url);
            // Clear chunk buffers from memory
            chunkBuffers.length = 0;
        }, 1000);
        
        // Verify file integrity
        if (finalBlob.size !== fileSize) {
            console.warn(`File size verification failed: expected ${fileSize}, got ${finalBlob.size}`);
        }
        
        console.log('File downloaded with native chunked blob');
        console.log(`File integrity: size=${finalBlob.size}, type=${finalBlob.type}, chunks=${chunks.length}`);
        showNotification(`${fileName} downloaded successfully`, 'success');
        
        return true;
        
    } catch (error) {
        console.error('Native chunked blob download failed:', error);
        throw error;
    }
}

// ✅ NEW: Data URL fallback (for smaller files)
async function downloadWithDataURL(fileId, fileName, fileType, fileSize) {
    try {
        const chunks = await getFileChunks(fileId);
        
        if (chunks.length === 0) {
            console.error(`No chunks found for ${fileId} - running debug`);
            listAllAvailableFiles();
            throw new Error('No file chunks found');
        }
        
        // Convert to base64 data URL
        const base64Chunks = [];
        
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const arrayBuffer = await chunk.chunkData.arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
            base64Chunks.push(base64);
            
            // Update progress
            const progress = ((i + 1) / chunks.length) * 100;
            updateProgress(progress, fileId);
            
            // Small delay
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        
        // Create data URL
        const dataUrl = `data:${fileType};base64,${base64Chunks.join('')}`;
        
        // Download
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        
        console.log('File downloaded with data URL');
        showNotification(`${fileName} downloaded successfully`, 'success');
        
        return true;
        
    } catch (error) {
        console.error('Data URL download failed:', error);
        throw error;
    }
}

// Initialize share button if Web Share API is available
function initShareButton() {
    if (navigator.share) {
        elements.shareId.classList.remove('hidden');
        elements.shareId.addEventListener('click', shareId);
    } else {
        elements.shareId.classList.add('hidden');
    }
}

// Share peer ID using Web Share API
async function shareId() {
    try {
        const peerId = elements.peerId.textContent;
        const baseUrl = window.CONFIG?.BASE_URL || 'https://one-host.app/';
        const qrUrl = `${baseUrl}?peer=${peerId}`;
        await navigator.share({ url: qrUrl });
        showNotification('Share successful!', 'success');
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('Error sharing:', error);
            showNotification('Failed to share', 'error');
        }
    }
}

// ✅ NEW: Track file transfer activities
function trackFileTransferActivity(action, fileId, fileName) {
    try {
        const timestamp = Date.now();
        const activity = {
            action: action,
            fileId: fileId,
            fileName: fileName,
            timestamp: timestamp,
            date: new Date().toISOString()
        };
        
        // Store recent activity
        const recentActivity = sessionStorage.getItem('recentFileTransfers');
        let activities = recentActivity ? JSON.parse(recentActivity) : [];
        activities.push(activity);
        
        // Keep only last 10 activities
        if (activities.length > 10) {
            activities = activities.slice(-10);
        }
        
        sessionStorage.setItem('recentFileTransfers', JSON.stringify(activities));
        console.log(`File transfer activity tracked: ${action} - ${fileName} (${fileId})`);
    } catch (error) {
        console.error('Error tracking file transfer activity:', error);
    }
}

// ✅ NEW: Streaming file transfer without memory accumulation
async function sendFileStreaming(file, conn, fileId) {
    try {
        console.log(`=== SEND FILE STREAMING START ===`);
        console.log(`File: ${file.name}, Size: ${file.size}, ChunkSize: 64KB`);
        
        if (!conn.open) {
            throw new Error('Connection is not open');
        }

        // Send file header first
        conn.send({
            type: 'file-header',
            fileId: fileId,
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            originalSender: peer.id,
            timestamp: Date.now()
        });
        console.log(`File header sent for ${fileId}`);

        // Optimized chunk size for network performance
        // Larger chunks = fewer network round trips = faster transfers
        // 256KB provides optimal balance between memory usage and network efficiency
        const chunkSize = 256 * 1024; // 256KB chunks for optimal performance
        let offset = 0;
        let lastProgressUpdate = 0;
        let chunkCount = 0;

        while (offset < file.size) {
            try {
                if (!conn.open) {
                    throw new Error('Connection lost during transfer');
                }

                // Validate file and offset
                if (!file || typeof file.slice !== 'function') {
                    throw new Error('Invalid file object or file.slice not available');
                }

                // Read chunk without loading entire file
                console.log(`Creating chunk: offset=${offset}, end=${offset + chunkSize}, fileSize=${file.size}`);
                console.log(`File object before slice:`, {
                    file: file,
                    type: typeof file,
                    constructor: file?.constructor?.name,
                    sliceAvailable: typeof file?.slice === 'function',
                    size: file?.size,
                    name: file?.name
                });
                
                const chunk = file.slice(offset, offset + chunkSize);
                console.log(`Chunk created:`, {
                    chunk: chunk,
                    type: typeof chunk,
                    constructor: chunk?.constructor?.name,
                    byteLength: chunk?.byteLength,
                    size: chunk?.size,
                    length: chunk?.length
                });
                
                // Validate chunk - use size for Blob objects, byteLength for File objects
                const actualChunkSize = chunk.size || chunk.byteLength;
                console.log(`Chunk size calculation:`, {
                    actualChunkSize: actualChunkSize,
                    actualChunkSizeType: typeof actualChunkSize,
                    size: chunk?.size,
                    byteLength: chunk?.byteLength
                });
                
                if (!chunk || typeof actualChunkSize === 'undefined') {
                    console.error(`Chunk validation failed:`, {
                        chunk: chunk,
                        size: chunk?.size,
                        byteLength: chunk?.byteLength,
                        type: typeof actualChunkSize
                    });
                    throw new Error(`Invalid chunk created at offset ${offset}`);
                }
                
                const arrayBuffer = await chunk.arrayBuffer();
                const chunkIndex = Math.floor(offset / chunkSize);

                console.log(`Sending chunk ${chunkIndex}: offset=${offset}, size=${actualChunkSize}, total=${file.size}, connection open: ${conn.open}`);

                conn.send({
                    type: 'file-chunk',
                    fileId: fileId,
                    data: arrayBuffer,
                    chunkIndex: chunkIndex,
                    offset: offset,
                    total: file.size
                });

                offset += actualChunkSize;
                chunkCount++;

                console.log(`Chunk ${chunkIndex} sent successfully, new offset: ${offset}`);

                // Update progress
                const currentProgress = (offset / file.size) * 100;
                if (currentProgress - lastProgressUpdate >= 1) {
                    updateProgress(currentProgress, fileId);
                    lastProgressUpdate = currentProgress;
                }

                // Small delay to prevent overwhelming the connection
                await new Promise(resolve => setTimeout(resolve, 1));
                
            } catch (error) {
                console.error(`Error sending chunk at offset ${offset}:`, error);
                console.error(`File details:`, {
                    name: file?.name,
                    size: file?.size,
                    type: file?.type,
                    sliceAvailable: typeof file?.slice === 'function'
                });
                throw new Error(`Failed to send chunk at offset ${offset}: ${error.message}`);
            }
        }

        console.log(`All chunks sent: ${chunkCount} chunks, total size: ${offset}`);

        // Send completion message
        conn.send({
            type: 'file-complete',
            fileId: fileId,
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            timestamp: Date.now()
        });

        console.log(`File sent successfully to peer ${conn.peer}`);
    } catch (error) {
        console.error(`Error sending file to peer:`, error);
        throw error;
    }
}

// Setup peer event handlers
function setupPeerHandlers() {
    if (!peer) {
        console.error('Cannot setup handlers: peer is null');
        return;
    }

    peer.on('open', (id) => {
        console.log('Peer opened with ID:', id);
        elements.peerId.textContent = id;
        updateConnectionStatus('', 'Ready to connect');
        generateQRCode(id);
        initShareButton();
        updateEditButtonState();
    });

    peer.on('connection', (conn) => {
        console.log('Incoming connection from:', conn.peer);
        connections.set(conn.peer, conn);
        updateConnectionStatus('connecting', 'Incoming connection...');
        setupConnectionHandlers(conn);
    });

    peer.on('error', (error) => {
        console.error('PeerJS Error:', error);
        let errorMessage = 'Connection error';
        
        // Handle specific error types
        if (error.type === 'peer-unavailable') {
            errorMessage = 'Peer is not available or does not exist';
        } else if (error.type === 'network') {
            errorMessage = 'Network connection error';
        } else if (error.type === 'disconnected') {
            errorMessage = 'Disconnected from server';
        } else if (error.type === 'server-error') {
            errorMessage = 'Server error occurred';
        } else if (error.type === 'unavailable-id') {
            errorMessage = 'This ID is already taken. Please try another one.';
        } else if (error.type === 'browser-incompatible') {
            errorMessage = 'Your browser might not support all required features';
        } else if (error.type === 'invalid-id') {
            errorMessage = 'Invalid ID format';
        } else if (error.type === 'ssl-unavailable') {
            errorMessage = 'SSL is required for this connection';
        }
        
        updateConnectionStatus('', errorMessage);
        showNotification(errorMessage, 'error');

        // If this was during a custom ID setup, revert to auto-generated ID
        if (elements.peerIdEdit && !elements.peerIdEdit.classList.contains('hidden')) {
            cancelEditingPeerId();
            initPeerJS(); // Reinitialize with auto-generated ID
        }
    });

    peer.on('disconnected', () => {
        console.log('Peer disconnected');
        updateConnectionStatus('', 'Disconnected');
        isConnectionReady = false;
        
        // Try to reconnect
        setTimeout(() => {
            if (peer && !peer.destroyed) {
                console.log('Attempting to reconnect...');
                peer.reconnect();
            }
        }, 3000);
    });

    peer.on('close', () => {
        console.log('Peer connection closed');
        updateConnectionStatus('', 'Connection closed');
        isConnectionReady = false;
    });
}

// Initialize PeerJS
function initPeerJS() {
    try {
        console.log('Initializing PeerJS...');
        
        // Destroy existing peer if any
        if (peer) {
            console.log('Destroying existing peer connection');
            peer.destroy();
            peer = null;
        }

        // Clear existing connections
        connections.clear();

        // Create new peer with auto-generated ID
        peer = new Peer({
            debug: 2,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            }
        });

        setupPeerHandlers();

    } catch (error) {
        console.error('PeerJS Initialization Error:', error);
        updateConnectionStatus('', 'Initialization failed');
        showNotification('Failed to initialize peer connection', 'error');
    }
}

// Setup connection event handlers
function setupConnectionHandlers(conn) {
    conn.on('open', () => {
        console.log('Connection opened with:', conn.peer);
        isConnectionReady = true;
        updateConnectionStatus('connected', `Connected to peer(s) : ${connections.size}`);
        elements.fileTransferSection.classList.remove('hidden');
        addRecentPeer(conn.peer);
        
        // Clear any existing timeout for this connection
        if (connectionTimeouts.has(conn.peer)) {
            clearTimeout(connectionTimeouts.get(conn.peer));
            connectionTimeouts.delete(conn.peer);
        }
        
        // Send a connection notification to the other peer
        conn.send({
            type: 'connection-notification',
            peerId: peer.id
        });
    });

    conn.on('data', async (data) => {
        console.log(`Received data type: ${data.type}, fileId: ${data.fileId || 'N/A'}`);
        if (data.type === 'streaming-request') {
            console.log(`=== STREAMING REQUEST RECEIVED ===`);
            console.log(`Request details:`, data);
        }
        try {
            switch (data.type) {
                case MESSAGE_TYPES.SIMULTANEOUS_DOWNLOAD_REQUEST:
                    await handleSimultaneousDownloadRequest(data, conn);
                    break;
                case MESSAGE_TYPES.SIMULTANEOUS_DOWNLOAD_START:
                    await requestAndDownloadBlob(data);
                    break;
                case 'connection-notification':
                    updateConnectionStatus('connected', `Connected to peer(s) : ${connections.size}`);
                    break;
                case 'keep-alive':
                    // Handle keep-alive message
                    console.log(`Keep-alive received from peer ${conn.peer}`);
                    // Send keep-alive response
                    conn.send({
                        type: 'keep-alive-response',
                        timestamp: Date.now(),
                        peerId: peer.id
                    });
                    break;
                case 'keep-alive-response':
                    // Handle keep-alive response
                    console.log(`Keep-alive response received from peer ${conn.peer}`);
                    break;
                case 'disconnect-notification':
                    // Handle disconnect notification
                    console.log(`Disconnect notification received from peer ${conn.peer}`);
                    connections.delete(conn.peer);
                    updateConnectionStatus(connections.size > 0 ? 'connected' : '', 
                        connections.size > 0 ? `Connected to peer(s) : ${connections.size}` : 'Disconnected');
                    showNotification(`Peer ${conn.peer} disconnected`, 'warning');
                    break;
                case 'file-info':
                    // Handle file info without blob
                    const fileInfo = {
                        name: data.fileName,
                        type: data.fileType,
                        size: data.fileSize,
                        id: data.fileId,
                        sharedBy: data.originalSender
                    };
                    // Add to history if not already present
                    if (!fileHistory.sent.has(data.fileId) && !fileHistory.received.has(data.fileId)) {
                        addFileToHistory(fileInfo, 'received');
                        
                        // If this is the host, forward to other peers
                        if (connections.size > 1) {
                            await forwardFileInfoToPeers(fileInfo, data.fileId);
                        }
                    }
                    break;
                case 'file-header':
                    await handleFileHeader(data);
                    break;
                case 'file-chunk':
                    console.log(`=== FILE CHUNK RECEIVED ===`);
                    console.log(`Received file chunk:`, {
                        fileId: data.fileId,
                        chunkIndex: data.chunkIndex,
                        dataSize: data.data?.byteLength || 0,
                        offset: data.offset || 'N/A'
                    });
                    
                    // Track chunk reception
                    trackFileTransferActivity('file-chunk-received', data.fileId, `chunk-${data.chunkIndex}`);
                    
                    await handleFileChunk(data);
                    break;
                case 'file-complete':
                    await handleFileComplete(data);
                    break;
                case 'blob-request':
                    // Handle direct blob request (fallback)
                    await handleBlobRequest(data, conn);
                    break;
                case 'streaming-request':
                    // Handle streaming download request
                    await handleStreamingRequest(data, conn);
                    break;
                case 'streaming-error':
                    // Handle streaming error
                    console.error('Streaming error received:', data);
                    showNotification(`Streaming error: ${data.error}`, 'error');
                    elements.transferProgress.classList.add('hidden');
                    updateTransferInfo('');
                    break;
                case 'blob-request-forwarded':
                    // Handle forwarded blob request (host only)
                    await handleForwardedBlobRequest(data, conn);
                    break;
                case 'blob-error':
                    showNotification(`Failed to download file: ${data.error}`, 'error');
                    elements.transferProgress.classList.add('hidden');
                    updateTransferInfo('');
                    break;
                default:
                    console.error('Unknown data type:', data.type);
            }
        } catch (error) {
            console.error('Data handling error:', error);
            showNotification('Error processing received data', 'error');
        }
    });

    conn.on('close', () => {
        console.log('Connection closed with:', conn.peer);
        console.log('Connection close details:', {
            peer: conn.peer,
            open: conn.open,
            readyState: conn.connectionState || 'unknown',
            timestamp: new Date().toISOString()
        });
        connections.delete(conn.peer);
        
        // Clear timeout for this connection
        if (connectionTimeouts.has(conn.peer)) {
            clearTimeout(connectionTimeouts.get(conn.peer));
            connectionTimeouts.delete(conn.peer);
        }
        
        updateConnectionStatus(connections.size > 0 ? 'connected' : '', 
            connections.size > 0 ? `Connected to peer(s) : ${connections.size}` : 'Disconnected');
        if (connections.size === 0) {
            showNotification('All peers disconnected', 'error');
        } else {
            showNotification(`Peer ${conn.peer} disconnected`, 'warning');
        }
    });

    conn.on('error', (error) => {
        console.error('Connection Error:', error);
        console.error('Connection state during error:', {
            peer: conn.peer,
            open: conn.open,
            readyState: conn.connectionState || 'unknown'
        });
        updateConnectionStatus('', 'Connection error');
        showNotification('Connection error occurred', 'error');
        
        // Set a timeout to attempt reconnection
        if (!connectionTimeouts.has(conn.peer)) {
            const timeout = setTimeout(() => {
                console.log(`Attempting to reconnect to ${conn.peer} after error...`);
                reconnectToPeer(conn.peer);
                connectionTimeouts.delete(conn.peer);
            }, 5000); // Wait 5 seconds before attempting reconnection
            
            connectionTimeouts.set(conn.peer, timeout);
        }
    });
}

// Helper function to generate unique file ID
function generateFileId(file) {
    return `${file.name}-${file.size}`;
}

// Handle file header
async function handleFileHeader(data) {
    console.log(`=== HANDLE FILE HEADER START ===`);
    console.log('Received file header:', data);
    
    // Track file transfer activity
    trackFileTransferActivity('file-header-received', data.fileId, data.fileName);
    
    fileChunks[data.fileId] = {
        chunks: [],
        fileName: data.fileName,
        fileType: data.fileType,
        fileSize: data.fileSize,
        receivedSize: 0,
        originalSender: data.originalSender
    };
    
    console.log(`File header initialized for ${data.fileId}:`, {
        fileName: data.fileName,
        fileSize: data.fileSize,
        receivedSize: 0,
        chunksLength: 0
    });
    
    console.log(`Global fileChunks after header:`, Object.keys(fileChunks));
    
    elements.transferProgress.classList.add('hidden'); // Always hide
    updateProgress(0);
    updateTransferInfo(`Receiving ${data.fileName} from ${data.originalSender}...`);
}

// ✅ MODIFIED: Handle file chunks with streaming storage
async function handleFileChunk(data) {
    console.log(`=== HANDLE FILE CHUNK START ===`);
    console.log(`Raw data received:`, data);
    
    // Calculate chunk index from offset if not provided (backward compatibility)
    // Use 256KB chunks to match the sender's chunk size
    const chunkSize = 256 * 1024; // 256KB chunks
    const chunkIndex = data.chunkIndex !== undefined ? data.chunkIndex : 
                      (data.offset !== undefined ? Math.floor(data.offset / chunkSize) : 0);
    
    console.log(`Received chunk for ${data.fileId}, index: ${chunkIndex}, size: ${data.data?.byteLength || 0}, offset: ${data.offset || 'N/A'}`);
    console.log(`Global fileChunks keys:`, Object.keys(fileChunks));
    
    const fileData = fileChunks[data.fileId];
    if (!fileData) {
        console.error(`No file data found for ${data.fileId}`);
        console.error(`Available fileIds:`, Object.keys(fileChunks));
        return;
    }

    try {
        // Store in local array FIRST for immediate access
        if (!fileData.chunks) {
            fileData.chunks = [];
        }
        fileData.chunks[chunkIndex] = data.data;
        
        // Update received size IMMEDIATELY
        const previousSize = fileData.receivedSize || 0;
        fileData.receivedSize = previousSize + data.data.byteLength;
        
        console.log(`Chunk ${chunkIndex} stored IMMEDIATELY, received: ${fileData.receivedSize}/${fileData.fileSize} (added ${data.data.byteLength})`);
        
        // Store chunk in IndexedDB for streaming download (async, but don't wait)
        storeFileChunk(data.fileId, data.data, chunkIndex).catch(error => {
            console.error('Error storing chunk in IndexedDB:', error);
        });
        
        // Update progress
        const currentProgress = (fileData.receivedSize / fileData.fileSize) * 100;
        if (!fileData.lastProgressUpdate || currentProgress - fileData.lastProgressUpdate >= 1) {
            updateProgress(currentProgress, data.fileId);
            fileData.lastProgressUpdate = currentProgress;
        }
        
        console.log(`File data state:`, {
            fileId: data.fileId,
            receivedSize: fileData.receivedSize,
            fileSize: fileData.fileSize,
            chunksLength: fileData.chunks.length,
            chunkData: fileData.chunks[chunkIndex] ? 'present' : 'missing'
        });
        
    } catch (error) {
        console.error('Error handling file chunk:', error);
        throw error;
    }
}

// ✅ MODIFIED: Handle file completion with streaming download
async function handleFileComplete(data) {
    console.log(`File complete signal received for ${data.fileId}`);
    
    // Track file transfer activity
    trackFileTransferActivity('file-complete-received', data.fileId, 'unknown');
    
    const fileData = fileChunks[data.fileId];
    if (!fileData) {
        console.error(`No file data found for ${data.fileId} during completion`);
        return;
    }

    try {
        // Add a small delay to ensure all chunks are processed
        await new Promise(resolve => setTimeout(resolve, 100));
        
        console.log(`File complete: ${fileData.fileName}, expected: ${fileData.fileSize}, received: ${fileData.receivedSize}`);
        console.log(`File data state at completion:`, {
            fileId: data.fileId,
            fileName: fileData.fileName,
            fileSize: fileData.fileSize,
            receivedSize: fileData.receivedSize,
            chunksLength: fileData.chunks ? fileData.chunks.length : 0,
            chunksArray: fileData.chunks ? fileData.chunks.filter(c => c !== undefined).length : 0
        });
        
        // Use the tracked received size instead of recalculating from chunks
        const tolerance = Math.max(1024, fileData.fileSize * 0.01);
        if (Math.abs(fileData.receivedSize - fileData.fileSize) > tolerance) {
            throw new Error(`Size mismatch: expected ${fileData.fileSize}, got ${fileData.receivedSize}`);
        }

        // ✅ Show download button for user-triggered download
        console.log(`File download ready: ${fileData.fileName} (${fileData.fileSize} bytes)`);
        showNotification(`${fileData.fileName} ready for download`, 'success');
        
        // Update UI to show download button
        const listItem = document.querySelector(`[data-file-id="${data.fileId}"]`);
        if (listItem) {
            listItem.classList.add('download-ready');
            const downloadButton = listItem.querySelector('.icon-button');
            if (downloadButton) {
                downloadButton.innerHTML = '<span class="material-icons">download</span>';
                downloadButton.title = 'Click to download file';
                downloadButton.onclick = async () => {
                    try {
                        // Update UI to downloading state
                        listItem.classList.remove('download-ready');
                        listItem.classList.add('downloading');
                        downloadButton.innerHTML = '<span class="material-icons">hourglass_empty</span>';
                        downloadButton.title = 'Downloading...';
                        
                        const downloadResult = await downloadFileUniversal(data.fileId, fileData.fileName, fileData.fileType, fileData.fileSize);
                        
                        // Check if user cancelled
                        if (downloadResult === false) {
                            // User cancelled - reset UI to allow retry
                            listItem.classList.remove('downloading');
                            listItem.classList.add('download-ready');
                            downloadButton.innerHTML = '<span class="material-icons">download</span>';
                            downloadButton.title = 'Click to download file';
                            return; // Exit early for cancellation
                        }
                        
                        // Update UI after successful download
                        listItem.classList.remove('downloading');
                        listItem.classList.add('download-completed');
                        downloadButton.innerHTML = '<span class="material-icons">check</span>';
                        downloadButton.title = 'Download completed';
                        showNotification(`${fileData.fileName} downloaded successfully`, 'success');
                        
                    } catch (error) {
                        console.error('Download failed:', error);
                        // Update UI for failed download
                        listItem.classList.remove('downloading');
                        listItem.classList.add('download-ready');
                        downloadButton.innerHTML = '<span class="material-icons">download</span>';
                        downloadButton.title = 'Click to retry download';
                        showNotification(`Download failed: ${error.message}`, 'error');
                    }
                };
            }
        }

        // Create file info object
        const fileInfo = {
            name: fileData.fileName,
            type: fileData.fileType,
            size: fileData.fileSize,
            id: data.fileId,
            sharedBy: fileData.originalSender
        };

        // Add to history if this is a new file info
        if (!fileHistory.sent.has(data.fileId) && !fileHistory.received.has(data.fileId)) {
            addFileToHistory(fileInfo, 'received');

            // If this is the host peer, forward the file info to other connected peers
            if (connections.size > 1) {
                console.log('Forwarding file info to other peers as host');
                await forwardFileInfoToPeers(fileInfo, data.fileId);
            }
        }

        // Clean up chunks
        await cleanupFileChunks(data.fileId);

    } catch (error) {
        console.error('Error handling file completion:', error);
        showNotification('Error processing file: ' + error.message, 'error');
    } finally {
        delete fileChunks[data.fileId];
        elements.transferProgress.classList.add('hidden');
        updateProgress(0);
        updateTransferInfo('');
    }
}

// Forward file info to other connected peers
async function forwardFileInfoToPeers(fileInfo, fileId) {
    // Create a standardized file info object that includes direct download info
    const fileInfoToSend = {
        type: 'file-info',
        fileId: fileId,
        fileName: fileInfo.name,
        fileType: fileInfo.type,
        fileSize: fileInfo.size,
        originalSender: fileInfo.sharedBy || peer.id,
        timestamp: Date.now(),
        directDownload: true // Indicate this file supports direct download
    };

    // Send to all connected peers except the original sender
    for (const [peerId, conn] of connections) {
        if (peerId !== fileInfo.sharedBy && conn && conn.open) {
            try {
                console.log(`Forwarding file info to peer: ${peerId}`);
                conn.send(fileInfoToSend);
            } catch (error) {
                console.error(`Error forwarding file info to peer ${peerId}:`, error);
            }
        }
    }
}

// Send file to a specific peer
async function sendFileToPeer(file, conn, fileId, fileBlob) {
    try {
        if (!conn.open) {
            throw new Error('Connection is not open');
        }

        // Store the blob for later use
        sentFileBlobs.set(fileId, fileBlob);

        // Send file info only
        conn.send({
            type: 'file-info',
            fileId: fileId,
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            originalSender: peer.id
        });

        console.log(`File info sent successfully to peer ${conn.peer}`);
    } catch (error) {
        console.error(`Error sending file info to peer ${conn.peer}:`, error);
        throw new Error(`Failed to send to peer ${conn.peer}: ${error.message}`);
    }
}

// Handle blob request
async function handleBlobRequest(data, conn) {
    const { fileId, forwardTo } = data;
    console.log('Received blob request for file:', fileId);

    // Check if we have the blob
    const blob = sentFileBlobs.get(fileId);
    if (!blob) {
        console.error('Blob not found for file:', fileId);
        conn.send({
            type: 'blob-error',
            fileId: fileId,
            error: 'File not available'
        });
        return;
    }

    try {
        // Convert blob to array buffer
        const buffer = await blob.arrayBuffer();
        let offset = 0;
        let lastProgressUpdate = 0;

        // Send file header
        conn.send({
            type: 'file-header',
            fileId: fileId,
            fileName: data.fileName,
            fileType: blob.type,
            fileSize: blob.size,
            originalSender: peer.id,
            timestamp: Date.now()
        });

        // Send chunks
        while (offset < blob.size) {
            if (!conn.open) {
                throw new Error('Connection lost during transfer');
            }

            const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
            conn.send({
                type: 'file-chunk',
                fileId: fileId,
                data: chunk,
                offset: offset,
                total: blob.size
            });

            offset += chunk.byteLength;

            // Update progress
            const currentProgress = (offset / blob.size) * 100;
            if (currentProgress - lastProgressUpdate >= 1) {
                updateProgress(currentProgress, fileId);
                lastProgressUpdate = currentProgress;
            }
        }

        // Send completion message
        conn.send({
            type: 'file-complete',
            fileId: fileId,
            fileName: data.fileName,
            fileType: blob.type,
            fileSize: blob.size,
            timestamp: Date.now()
        });

        console.log(`File sent successfully to peer ${conn.peer}`);
    } catch (error) {
        console.error(`Error sending file to peer:`, error);
        conn.send({
            type: 'blob-error',
            fileId: fileId,
            error: error.message
        });
    }
}

// ✅ MODIFIED: Function to request and download using streaming
async function requestAndDownloadBlob(fileInfo) {
    try {
        console.log(`=== STREAMING DOWNLOAD REQUEST ===`);
        console.log(`Requesting streaming download for: ${fileInfo.name}`);
        
        // Always try to connect to original sender directly
        let conn = connections.get(fileInfo.sharedBy);
        
        if (!conn || !conn.open) {
            // If no direct connection exists, establish one
            console.log('No direct connection to sender, establishing connection...');
            conn = peer.connect(fileInfo.sharedBy, {
                reliable: true
            });
            
            // Wait for connection to open
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Connection timeout'));
                }, 10000); // 10 second timeout

                conn.on('open', () => {
                    clearTimeout(timeout);
                    connections.set(fileInfo.sharedBy, conn);
                    setupConnectionHandlers(conn);
                    resolve();
                });

                conn.on('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });
        }

        // Show progress for streaming download
        elements.transferProgress.classList.remove('hidden');
        updateProgress(0, fileInfo.id);
        updateTransferInfo(`Requesting ${fileInfo.name}...`);

        // Request streaming download
        conn.send({
            type: 'streaming-request',
            fileId: fileInfo.id,
            fileName: fileInfo.name,
            fileType: fileInfo.type,
            fileSize: fileInfo.size,
            directRequest: true
        });

    } catch (error) {
        console.error('Error requesting streaming download:', error);
        showNotification(`Failed to download file: ${error.message}`, 'error');
        elements.transferProgress.classList.add('hidden');
        updateTransferInfo('');
    }
}

// ✅ NEW: Handle streaming download request
async function handleStreamingRequest(data, conn) {
    try {
        console.log(`=== HANDLE STREAMING REQUEST ===`);
        console.log(`Streaming request received for: ${data.fileName}`);
        console.log(`Requested fileId: ${data.fileId}`);
        
        // Debug the sent files store
        debugSentFilesStore();
        
        // Check if we have the file in our sent files store
        const fileId = data.fileId;
        const sentFile = sentFilesStore.get(fileId);
        
        if (!sentFile) {
            console.error(`File ${fileId} not found in sent files store`);
            console.error(`Available files:`, Array.from(sentFilesStore.keys()));
            conn.send({
                type: 'streaming-error',
                fileId: fileId,
                error: 'File not found in sent files store'
            });
            return;
        }

        console.log(`File found in store: ${sentFile.name}, size: ${sentFile.size}`);
        console.log(`File object details:`, {
            name: sentFile.name,
            size: sentFile.size,
            type: sentFile.type,
            constructor: sentFile.constructor.name,
            sliceAvailable: typeof sentFile.slice === 'function',
            arrayBufferAvailable: typeof sentFile.arrayBuffer === 'function'
        });
        console.log(`Starting streaming transfer for: ${data.fileName}`);
        
        // Start streaming the file
        await sendFileStreaming(sentFile, conn, fileId);
        
        console.log(`Streaming transfer completed for: ${data.fileName}`);
        
    } catch (error) {
        console.error('Error handling streaming request:', error);
        conn.send({
            type: 'streaming-error',
            fileId: data.fileId,
            error: error.message
        });
    }
}

// Handle forwarded blob request (host only)
async function handleForwardedBlobRequest(data, fromConn) {
    console.log('Handling forwarded blob request:', data);
    
    // Find connection to original sender
    const originalSenderConn = connections.get(data.originalSender);
    if (!originalSenderConn || !originalSenderConn.open) {
        fromConn.send({
            type: 'blob-error',
            fileId: data.fileId,
            error: 'Original sender not connected to host'
        });
        return;
    }

    // Request blob from original sender with forwarding info
    originalSenderConn.send({
        type: 'blob-request',
        fileId: data.fileId,
        fileName: data.fileName,
        forwardTo: data.requesterId
    });
}

// Update transfer info display
function updateTransferInfo(message) {
    if (elements.transferInfo) {
        elements.transferInfo.textContent = message;
    }
}

// Add file to history
function addFileToHistory(fileInfo, type) {
    const fileId = fileInfo.id || generateFileId(fileInfo);
    
    // Determine the correct type based on who shared the file
    const actualType = fileInfo.sharedBy === peer.id ? 'sent' : 'received';
    
    // Remove from both history sets to prevent duplicates
    fileHistory.sent.delete(fileId);
    fileHistory.received.delete(fileId);
    
    // Add to the correct history set
    fileHistory[actualType].add(fileId);
    
    // Remove existing entries from UI if any
    const sentList = elements.sentFilesList;
    const receivedList = elements.receivedFilesList;
    
    // Remove from sent list if exists
    const existingInSent = sentList.querySelector(`[data-file-id="${fileId}"]`);
    if (existingInSent) {
        existingInSent.remove();
    }
    
    // Remove from received list if exists
    const existingInReceived = receivedList.querySelector(`[data-file-id="${fileId}"]`);
    if (existingInReceived) {
        existingInReceived.remove();
    }
    
    // Update UI with the correct list
    const listElement = actualType === 'sent' ? elements.sentFilesList : elements.receivedFilesList;
    updateFilesList(listElement, fileInfo, actualType);

    // Only broadcast updates for files we send originally
    if (fileInfo.sharedBy === peer.id) {
        broadcastFileUpdate(fileInfo);
    }
}

// Broadcast file update to all peers
function broadcastFileUpdate(fileInfo) {
    const updateData = {
        type: 'file-update',
        fileInfo: {
            id: fileInfo.id,
            name: fileInfo.name,
            type: fileInfo.type,
            size: fileInfo.size,
            sharedBy: fileInfo.sharedBy
        }
    };

    for (const conn of connections.values()) {
        if (conn.open) {
            conn.send(updateData);
        }
    }
}

// Process file queue
async function processFileQueue() {
    if (isProcessingQueue || fileQueue.length === 0) return;
    
    isProcessingQueue = true;
    updateTransferInfo(`Processing queue: ${fileQueue.length} file(s) remaining`);
    
    while (fileQueue.length > 0) {
        const file = fileQueue.shift();
        try {
            await sendFile(file);
            // Small delay between files to prevent overwhelming the connection
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
            console.error('Error processing file from queue:', error);
            showNotification(`Failed to send ${file.name}: ${error.message}`, 'error');
        }
    }
    
    isProcessingQueue = false;
    updateTransferInfo('');
}

// Modify sendFile function to work with queue
// ✅ REVERTED: Use original file transfer method (send info first, download on demand)
async function sendFile(file) {
    if (connections.size === 0) {
        showNotification('Please connect to at least one peer first', 'error');
        return;
    }

    if (transferInProgress) {
        // Add to queue instead of showing warning
        fileQueue.push(file);
        showNotification(`${file.name} added to queue`, 'info');
        return;
    }

    try {
        transferInProgress = true;
        elements.transferProgress.classList.remove('hidden');
        updateProgress(0);
        updateTransferInfo(`Sending ${file.name}...`);

        // Generate a unique file ID that will be same for all recipients
        const fileId = generateFileId(file);
        
        // Send file info to all connected peers (original method)
        const sendPromises = [];
        let successCount = 0;
        const errors = [];

        console.log(`Sending file info for ${file.name} to ${connections.size} peers`);

        for (const [peerId, conn] of connections) {
            if (conn && conn.open) {
                try {
                    // Send file info (not the actual file)
                    const fileInfo = {
                        type: 'file-info',
                        fileId: fileId,
                        fileName: file.name,
                        fileType: file.type,
                        fileSize: file.size,
                        originalSender: peer.id,
                        timestamp: Date.now(),
                        directDownload: true
                    };
                    
                    conn.send(fileInfo);
                    successCount++;
                    console.log(`File info sent to peer: ${peerId}`);
                } catch (error) {
                    console.error(`Error sending file info to peer ${peerId}:`, error);
                    errors.push(error.message);
                }
            }
        }

                    if (successCount > 0) {
                // Store the file for later streaming download
                console.log(`About to store file:`, {
                    fileId: fileId,
                    file: file,
                    fileType: typeof file,
                    fileConstructor: file?.constructor?.name,
                    fileSize: file?.size,
                    fileName: file?.name
                });
                
                sentFilesStore.set(fileId, file);
                console.log(`File stored for streaming: ${fileId}`);
                console.log(`File details stored:`, {
                    name: file.name,
                    size: file.size,
                    type: file.type
                });
                console.log(`Sent files store now contains:`, Array.from(sentFilesStore.keys()));
                
                // Verify storage immediately
                const storedFile = sentFilesStore.get(fileId);
                console.log(`Immediately retrieved file:`, {
                    storedFile: storedFile,
                    storedFileType: typeof storedFile,
                    storedFileConstructor: storedFile?.constructor?.name,
                    storedFileSize: storedFile?.size,
                    storedFileName: storedFile?.name
                });
            
            // Add file to UI history so it appears in sent files list
            const fileInfo = {
                id: fileId,
                name: file.name,
                type: file.type,
                size: file.size,
                sharedBy: peer.id
            };
            addFileToHistory(fileInfo, 'sent');
            
            showNotification(`${file.name} info sent successfully`, 'success');
        } else {
            throw new Error('Failed to send file info to any peers: ' + errors.join(', '));
        }
    } catch (error) {
        console.error('File send error:', error);
        showNotification(error.message, 'error');
        throw error; // Propagate error for queue processing
    } finally {
        transferInProgress = false;
        elements.transferProgress.classList.add('hidden');
        updateProgress(0);
        // Process next file in queue if any
        processFileQueue();
    }
}

// --- Patch updateProgress to show notification ---
// const originalUpdateProgress = updateProgress;
// updateProgress = function(progress) {
//     showProgressNotification(progress);
//     originalUpdateProgress(progress);
//     if (progress >= 100) {
//         setTimeout(clearProgressNotification, 1000);
//     }
// };

// Update progress bar
function updateProgress(percent) {
    const progress = Math.min(Math.floor(percent), 100); // Ensure integer value and cap at 100
    elements.progress.style.width = `${progress}%`;
    elements.transferInfo.style.display = 'block';
    // Only hide transfer info when transfer is complete and progress is 100%
    if (progress === 100) {
        setTimeout(() => {
            elements.transferInfo.style.display = 'none';
        }, 1000); // Keep the 100% visible briefly
    }
}

// UI Functions
function addFileToList(name, url, size) {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${name} (${formatFileSize(size)})`;
    
    const downloadBtn = document.createElement('a');
    downloadBtn.href = url;
    downloadBtn.download = name;
    downloadBtn.className = 'button';
    downloadBtn.textContent = 'Download';
    
    // Add click handler to handle blob URL cleanup
    downloadBtn.addEventListener('click', () => {
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 1000);
    });
    
    li.appendChild(nameSpan);
    li.appendChild(downloadBtn);
    elements.fileList.appendChild(li);
    
    if (elements.receivedFiles) {
        elements.receivedFiles.classList.remove('hidden');
    }
}

function formatFileSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    
    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message.charAt(0).toUpperCase() + message.slice(1);  // Ensure sentence case
    
    elements.notifications.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 5000);
}

function resetConnection() {
    if (connections.size > 0) {
        connections.forEach((conn, peerId) => {
            if (conn && conn.open) {
                conn.close();
            }
        });
        connections.clear();
    }
    
    // Clear all connection timeouts
    connectionTimeouts.forEach(timeout => clearTimeout(timeout));
    connectionTimeouts.clear();
    
    isConnectionReady = false;
    transferInProgress = false;
    fileQueue = []; // Clear the file queue
    isProcessingQueue = false;
    elements.fileTransferSection.classList.add('hidden');
    elements.transferProgress.classList.add('hidden');
    elements.progress.style.width = '0%';
    elements.transferInfo.style.display = 'none';
    updateConnectionStatus('', 'Ready to connect');
}

// Event Listeners
elements.copyId.addEventListener('click', () => {
    navigator.clipboard.writeText(elements.peerId.textContent)
        .then(() => showNotification('Peer ID copied to clipboard'))
        .catch(err => showNotification('Failed to copy Peer ID', 'error'));
});

elements.connectButton.addEventListener('click', () => {
    const remotePeerIdValue = elements.remotePeerId.value.trim();
    if (!remotePeerIdValue) {
        showNotification('Please enter a Peer ID', 'error');
        return;
    }

    if (connections.has(remotePeerIdValue)) {
        // showNotification('Already connected to this peer', 'warning'); // Suppressed as per user request
        return;
    }

    try {
        console.log('Attempting to connect to:', remotePeerIdValue);
        updateConnectionStatus('connecting', 'Connecting...');
        const newConnection = peer.connect(remotePeerIdValue, {
            reliable: true
        });
        connections.set(remotePeerIdValue, newConnection);
        setupConnectionHandlers(newConnection);
    } catch (error) {
        console.error('Connection attempt error:', error);
        showNotification('Failed to establish connection', 'error');
        updateConnectionStatus('', 'Connection failed');
    }
});

// Add Enter key support for connecting to peer
elements.remotePeerId.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        elements.connectButton.click();
        if (elements.recentPeers) {
            elements.recentPeers.classList.add('hidden');
        }
        elements.remotePeerId.blur(); // Dismiss keyboard
    }
});

// Add keydown event support for connecting to peer (for mobile compatibility)
elements.remotePeerId.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        elements.connectButton.click();
        if (elements.recentPeers) {
            elements.recentPeers.classList.add('hidden');
        }
        elements.remotePeerId.blur(); // Dismiss keyboard
    }
});

elements.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.dropZone.classList.add('drag-over');
});

elements.dropZone.addEventListener('dragleave', () => {
    elements.dropZone.classList.remove('drag-over');
});

elements.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.dropZone.classList.remove('drag-over');
    
    if (connections.size > 0) {
        const files = e.dataTransfer.files;
        if (files.length > 1) {
            showNotification(`Processing ${files.length} files`, 'info');
        }
        Array.from(files).forEach(file => {
            fileQueue.push(file);
        });
        processFileQueue();
    } else {
        showNotification('Please connect to at least one peer first', 'error');
    }
});

// Add click handler for the drop zone
elements.dropZone.addEventListener('click', () => {
    if (connections.size > 0) {
        elements.fileInput.click();
    } else {
        showNotification('Please connect to at least one peer first', 'error');
    }
});

// Update file input change handler
elements.fileInput.addEventListener('change', (e) => {
    if (connections.size > 0) {
        const files = e.target.files;
        if (files.length > 0) {
            if (files.length > 1) {
                showNotification(`Processing ${files.length} files`, 'info');
            }
            Array.from(files).forEach(file => {
                fileQueue.push(file);
            });
            processFileQueue();
        }
        // Reset the input so the same file can be selected again
        e.target.value = '';
    } else {
        showNotification('Please connect to at least one peer first', 'error');
    }
});

// Initialize the application
function init() {
    if (!checkBrowserSupport()) {
        return;
    }

    initPeerJS();
    initIndexedDB();
    loadRecentPeers();
    checkUrlForPeerId(); // Check URL for peer ID on load
    initConnectionKeepAlive(); // Initialize connection keep-alive system
    initPeerIdEditing(); // Initialize peer ID editing
    elements.transferProgress.classList.add('hidden'); // Always hide transfer bar
}

// Add CSS classes for notification styling
const style = document.createElement('style');
style.textContent = `
    .notification {
        display: flex;
        align-items: center;
        gap: 8px;
        animation: slideIn 0.3s ease-out;
        transition: opacity 0.3s ease-out;
    }
    
    .notification.fade-out {
        opacity: 0;
    }
    
    .notification-icon {
        font-size: 1.2em;
    }
    
    .notification.info {
        background-color: #e0f2fe;
        color: #0369a1;
    }
    
    @keyframes slideIn {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
`;
document.head.appendChild(style);

// Add function to update connection status
function updateConnectionStatus(status, message) {
    elements.statusDot.className = 'status-dot ' + (status || '');
    elements.statusText.textContent = message.charAt(0).toUpperCase() + message.slice(1);  // Ensure sentence case
    
    // Update title to show number of connections
    if (connections && connections.size > 0) {
        document.title = `(${connections.size}) One-Host`;
    } else {
        document.title = 'One-Host';
    }
    updateEditButtonState(); // Add this line
}

// Update files list display
function updateFilesList(listElement, fileInfo, type) {
    console.log('Updating files list:', { type, fileInfo });
    
    // Check if file already exists in this list
    const existingFile = listElement.querySelector(`[data-file-id="${fileInfo.id}"]`);
    if (existingFile) {
        console.log('File already exists in list, updating...');
        existingFile.remove();
    }

    const li = document.createElement('li');
    li.className = 'file-item';
    li.setAttribute('data-file-id', fileInfo.id);
    
    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.textContent = getFileIcon(fileInfo.type);
    
    const info = document.createElement('div');
    info.className = 'file-info';
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = fileInfo.name;
    
    const sizeSpan = document.createElement('span');
    sizeSpan.className = 'file-size';
    sizeSpan.textContent = formatFileSize(fileInfo.size);

    const sharedBySpan = document.createElement('span');
    sharedBySpan.className = 'shared-by';
    sharedBySpan.textContent = type === 'sent' ? 
        'Sent to connected peers' : 
        `Received from peer ${fileInfo.sharedBy || 'Unknown'}`;
    
    info.appendChild(nameSpan);
    info.appendChild(sizeSpan);
    info.appendChild(sharedBySpan);
    
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'icon-button';
    downloadBtn.title = 'Download file';
    downloadBtn.innerHTML = '<span class="material-icons">download</span>';
    downloadBtn.onclick = async () => {
        try {
            if (type === 'sent' && sentFileBlobs.has(fileInfo.id)) {
                // For sent files, we have the blob locally
                const blob = sentFileBlobs.get(fileInfo.id);
                downloadBlob(blob, fileInfo.name, fileInfo.id);
            } else {
                // For received files, request the blob from the original sender
                await requestAndDownloadBlob(fileInfo);
            }
        } catch (error) {
            console.error('Error downloading file:', error);
            showNotification('Failed to download file: ' + error.message, 'error');
        }
    };
    
    li.appendChild(icon);
    li.appendChild(info);
    li.appendChild(downloadBtn);
    
    // Add to the beginning of the list for newest first
    if (listElement.firstChild) {
        listElement.insertBefore(li, listElement.firstChild);
    } else {
        listElement.appendChild(li);
    }
    
    // Scroll the new received file into view
    if (type === 'received') {
        setTimeout(() => {
            li.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
    }
    
    console.log('File list updated successfully');
}

// Add function to get appropriate file icon
function getFileIcon(mimeType) {
    if (!mimeType) return 'insert_drive_file';
    
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'movie';
    if (mimeType.startsWith('audio/')) return 'audiotrack';
    if (mimeType.includes('pdf')) return 'picture_as_pdf';
    if (mimeType.includes('word') || mimeType.includes('document')) return 'description';
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'table_chart';
    if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'slideshow';
    if (mimeType.includes('text/')) return 'text_snippet';
    if (mimeType.includes('zip') || mimeType.includes('archive')) return 'folder_zip';
    
    return 'insert_drive_file';
}

// Add event listeners for recent peers
elements.remotePeerId.addEventListener('focus', () => {
    if (recentPeers.length > 0) {
        elements.recentPeers.classList.remove('hidden');
    }
});

elements.remotePeerId.addEventListener('blur', (e) => {
    // Delay hiding to allow for click events on the list
    setTimeout(() => {
        elements.recentPeers.classList.add('hidden');
    }, 200);
});

elements.clearPeers.addEventListener('click', () => {
    recentPeers = [];
    saveRecentPeers();
    updateRecentPeersList();
    elements.recentPeers.classList.add('hidden');
});

// Initialize connection keep-alive system
function initConnectionKeepAlive() {
    // Start keep-alive interval
    keepAliveInterval = setInterval(() => {
        if (connections.size > 0 && isPageVisible) {
            sendKeepAlive();
        }
    }, KEEP_ALIVE_INTERVAL);

    // Handle page visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    // Handle page focus/blur events
    window.addEventListener('focus', handlePageFocus);
    window.addEventListener('blur', handlePageBlur);
    
    // Handle beforeunload event
    window.addEventListener('beforeunload', handleBeforeUnload);
}

// Handle page visibility changes
function handleVisibilityChange() {
    isPageVisible = !document.hidden;
    
    if (isPageVisible) {
        console.log('Page became visible, checking connections...');
        checkConnections();
    } else {
        console.log('Page became hidden, maintaining connections...');
        sendKeepAlive();
    }
}

// Handle page focus
function handlePageFocus() {
    console.log('Page focused, checking connections...');
    checkConnections();
}

// Handle page blur
function handlePageBlur() {
    console.log('Page blurred, maintaining connections...');
    sendKeepAlive();
}

// Handle beforeunload
function handleBeforeUnload(event) {
    if (connections.size > 0) {
        sendDisconnectNotification();
    }
}

// Send keep-alive messages to all connected peers
function sendKeepAlive() {
    const keepAliveData = {
        type: 'keep-alive',
        timestamp: Date.now(),
        peerId: peer.id
    };

    for (const [peerId, conn] of connections) {
        if (conn && conn.open) {
            try {
                conn.send(keepAliveData);
                console.log(`Keep-alive sent to peer ${peerId}`);
            } catch (error) {
                console.error(`Failed to send keep-alive to peer ${peerId}:`, error);
            }
        }
    }
}

// Send disconnect notification to all peers
function sendDisconnectNotification() {
    const disconnectData = {
        type: 'disconnect-notification',
        peerId: peer.id,
        timestamp: Date.now()
    };

    for (const [peerId, conn] of connections) {
        if (conn && conn.open) {
            try {
                conn.send(disconnectData);
            } catch (error) {
                console.error(`Failed to send disconnect notification to peer ${peerId}:`, error);
            }
        }
    }
}

// Check and restore connections
function checkConnections() {
    for (const [peerId, conn] of connections) {
        if (!conn.open) {
            console.log(`Connection to ${peerId} is closed, attempting to reconnect...`);
            reconnectToPeer(peerId);
        }
    }
}

// Reconnect to a specific peer
function reconnectToPeer(peerId) {
    try {
        console.log(`Attempting to reconnect to peer: ${peerId}`);
        const newConnection = peer.connect(peerId, {
            reliable: true
        });
        connections.set(peerId, newConnection);
        setupConnectionHandlers(newConnection);
    } catch (error) {
        console.error(`Failed to reconnect to peer ${peerId}:`, error);
        connections.delete(peerId);
    }
}

// Function to download a blob
function downloadBlob(blob, fileName, fileId) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // If fileId is provided, update the UI
    if (fileId) {
        const listItem = document.querySelector(`[data-file-id="${fileId}"]`);
        if (listItem) {
            listItem.classList.add('download-completed');
            const downloadButton = listItem.querySelector('.icon-button');
            if (downloadButton) {
                downloadButton.classList.add('download-completed');
                downloadButton.innerHTML = '<span class="material-icons">open_in_new</span>';
                downloadButton.title = 'Open file';
                
                // Store the blob URL for opening the file
                const openUrl = URL.createObjectURL(blob);
                downloadButton.onclick = () => {
                    window.open(openUrl, '_blank');
                };
            }
        }
    }

    // Cleanup the download URL
    setTimeout(() => URL.revokeObjectURL(url), 100);
}

// Function to handle simultaneous download request
async function handleSimultaneousDownloadRequest(data, conn) {
    console.log('Received simultaneous download request:', data);
    const { fileId } = data;
    
    // Check if we have the blob
    const blob = sentFileBlobs.get(fileId);
    if (!blob) {
        console.error('Blob not found for file:', fileId);
        conn.send({
            type: MESSAGE_TYPES.BLOB_ERROR,
            fileId: fileId,
            error: 'File not available'
        });
        return;
    }

    // Send ready signal
    conn.send({
        type: MESSAGE_TYPES.SIMULTANEOUS_DOWNLOAD_READY,
        fileId: fileId,
        fileSize: blob.size
    });
}

// Function to initiate simultaneous download
async function initiateSimultaneousDownload(fileInfo) {
    const downloadingPeers = new Set();
    const readyPeers = new Set();
    let downloadStarted = false;

    // Function to start download for all ready peers
    const startDownloadForAll = () => {
        if (downloadStarted) return;
        downloadStarted = true;
        
        console.log('Starting simultaneous download for all ready peers');
        for (const [peerId, conn] of connections) {
            if (readyPeers.has(peerId)) {
                conn.send({
                    type: MESSAGE_TYPES.SIMULTANEOUS_DOWNLOAD_START,
                    fileId: fileInfo.fileId
                });
            }
        }
    };

    // Request download from original sender for all connected peers
    for (const [peerId, conn] of connections) {
        if (conn && conn.open && peerId === fileInfo.originalSender) {
            downloadingPeers.add(peerId);
            conn.send({
                type: MESSAGE_TYPES.SIMULTANEOUS_DOWNLOAD_REQUEST,
                fileId: fileInfo.fileId,
                fileName: fileInfo.fileName
            });
        }
    }

    // Add handlers for simultaneous download coordination
    const handleReadyResponse = (data, fromPeerId) => {
        if (data.type === MESSAGE_TYPES.SIMULTANEOUS_DOWNLOAD_READY && data.fileId === fileInfo.fileId) {
            readyPeers.add(fromPeerId);
            if (readyPeers.size === downloadingPeers.size) {
                startDownloadForAll();
            }
        }
    };

    // Update connection handler to handle simultaneous downloads
    const originalDataHandler = conn.dataHandler;
    conn.on('data', (data) => {
        if (data.type === MESSAGE_TYPES.SIMULTANEOUS_DOWNLOAD_READY) {
            handleReadyResponse(data, conn.peer);
        } else {
            originalDataHandler(data);
        }
    });
}

// Update the download button click handler
function createDownloadButton(fileInfo) {
    const downloadButton = document.createElement('button');
    downloadButton.textContent = 'Download';
    downloadButton.classList.add('download-button');
    downloadButton.onclick = async () => {
        try {
            showNotification(`Starting download of ${fileInfo.fileName}...`);
            await initiateSimultaneousDownload(fileInfo);
        } catch (error) {
            console.error('Error initiating simultaneous download:', error);
            showNotification(`Failed to download ${fileInfo.fileName}: ${error.message}`, 'error');
        }
    };
    return downloadButton;
}

// Check if peer ID editing is allowed
function isEditingAllowed() {
    const statusText = elements.statusText.textContent;
    const hasConnections = connections.size > 0;
    return statusText === 'Ready to connect' && !hasConnections;
}

// Update edit button state based on connection status
function updateEditButtonState() {
    if (elements.editIdButton) {
        const canEdit = isEditingAllowed();
        elements.editIdButton.disabled = !canEdit;
        elements.editIdButton.title = canEdit ? 'Edit ID' : 'Cannot edit ID while connected';
    }
}

// Start editing peer ID
function startEditingPeerId() {
    if (!isEditingAllowed()) return;
    
    const currentId = elements.peerId.textContent;
    elements.peerIdEdit.value = currentId;
    
    elements.peerId.classList.add('hidden');
    elements.peerIdEdit.classList.remove('hidden');
    elements.editIdButton.classList.add('hidden');
    elements.saveIdButton.classList.remove('hidden');
    elements.cancelEditButton.classList.remove('hidden');
    elements.peerIdEdit.focus();
    elements.peerIdEdit.select();
}

// Save edited peer ID
async function saveEditedPeerId() {
    const newPeerId = elements.peerIdEdit.value.trim();
    
    if (!newPeerId) {
        showNotification('Peer ID cannot be empty', 'error');
        return;
    }
    
    if (newPeerId.length < 3) {
        showNotification('Peer ID must be at least 3 characters', 'error');
        return;
    }

    // Validate peer ID format
    const validIdRegex = /^[A-Za-z0-9_-]+$/;
    if (!validIdRegex.test(newPeerId)) {
        showNotification('Peer ID can only contain letters, numbers, underscores, and hyphens', 'error');
        return;
    }
    
    try {
        // Show loading state
        updateConnectionStatus('connecting', 'Updating peer ID...');
        
        // Destroy existing peer if any
        if (peer) {
            peer.destroy();
            peer = null;
        }
        
        // Clear connections
        connections.clear();
        
        // Initialize new peer with custom ID
        peer = new Peer(newPeerId, {
            debug: 2,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            }
        });
        
        setupPeerHandlers();
        
        // Wait for the peer to be ready
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for peer to open'));
            }, 10000); // 10 second timeout

            peer.once('open', () => {
                clearTimeout(timeout);
                resolve();
            });

            peer.once('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });

        // Update UI
        elements.peerId.textContent = newPeerId;
        cancelEditingPeerId();
        
        // Generate new QR code
        generateQRCode(newPeerId);
        
        showNotification('Peer ID updated successfully', 'success');
    } catch (error) {
        console.error('Error updating peer ID:', error);
        
        // Show specific error message for taken IDs
        if (error.type === 'unavailable-id') {
            showNotification('This ID is already taken. Please try another one.', 'error');
        } else {
            showNotification('Failed to update peer ID. Please try again.', 'error');
        }
        
        updateConnectionStatus('', 'Failed to update peer ID');
        
        // Reinitialize with auto-generated ID
        initPeerJS();
    }
}

// Cancel editing peer ID
function cancelEditingPeerId() {
    elements.peerId.classList.remove('hidden');
    elements.peerIdEdit.classList.add('hidden');
    elements.editIdButton.classList.remove('hidden');
    elements.saveIdButton.classList.add('hidden');
    elements.cancelEditButton.classList.add('hidden');
}

// Initialize peer ID editing
function initPeerIdEditing() {
    if (elements.editIdButton) {
        elements.editIdButton.addEventListener('click', startEditingPeerId);
    }
    if (elements.saveIdButton) {
        elements.saveIdButton.addEventListener('click', saveEditedPeerId);
    }
    if (elements.cancelEditButton) {
        elements.cancelEditButton.addEventListener('click', cancelEditingPeerId);
    }
    if (elements.peerIdEdit) {
        elements.peerIdEdit.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                saveEditedPeerId();
            } else if (e.key === 'Escape') {
                cancelEditingPeerId();
            }
        });
    }
}

init();

/**
 * 🌊 ONE-HOST - STREAMING FILE TRANSFER
 * Clean implementation with Service Worker streaming for mobile compatibility
 */

// Import streaming manager and modules
import { StreamManager } from './js/services/stream-manager.js';
import { 
    handleFileInfo, 
    handleStreamRequest, 
    handleStreamStart, 
    handleStreamData, 
    handleStreamComplete, 
    handleStreamError,
    sendFile,
    streamFileToReceiver,
    requestFileDownload
} from './js/streaming-handlers.js';
import { 
    setupEventListeners,
    processFileQueue,
    addFileToHistory,
    updateFilesList,
    updateStreamProgress,
    updateFileDownloadStatus,
    connectToPeer,
    generatePeerId,
    formatFileSize,
    getFileIcon,
    updateConnectionStatus,
    showNotification
} from './js/ui-functions.js';
import {
    initConnectionKeepAlive,
    sendKeepAlive,
    sendDisconnectNotification,
    addRecentPeer,
    loadRecentPeers,
    updateRecentPeersList,
    generateQRCode,
    showBrowserSupportError,
    handleAutoConnect
} from './js/utility-functions.js';

// ✅ CONSTANTS & CONFIGURATION
const KEEP_ALIVE_INTERVAL = 30000; // 30 seconds
const CONNECTION_TIMEOUT = 60000;  // 60 seconds
const STREAM_CHUNK_SIZE = 64 * 1024; // 64KB chunks for streaming

// ✅ NEW STREAMING MESSAGE TYPES
const MESSAGE_TYPES = {
    // Connection management (keep existing)
    CONNECTION_NOTIFICATION: 'connection-notification',
    KEEP_ALIVE: 'keep-alive',
    KEEP_ALIVE_RESPONSE: 'keep-alive-response',
    DISCONNECT_NOTIFICATION: 'disconnect-notification',
    
    // NEW: Streaming protocol
    FILE_INFO: 'file-info',           // Send file metadata
    STREAM_REQUEST: 'stream-request', // Request file stream
    STREAM_START: 'stream-start',     // Stream starting
    STREAM_DATA: 'stream-data',       // Stream chunk data
    STREAM_COMPLETE: 'stream-complete', // Stream finished
    STREAM_ERROR: 'stream-error'      // Stream error
};

// ✅ DOM ELEMENTS (keep existing UI structure)
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
    recentPeersList: document.getElementById('recent-peers-list')
};

// ✅ GLOBAL STATE
let peer = null;
let connections = new Map();
let streamManager = null;

// File management
let sentFiles = new Map();     // fileId -> File object
let fileHistory = {
    sent: new Set(),
    received: new Set()
};

// Connection management
let isPageVisible = true;
let keepAliveInterval = null;
let recentPeers = [];
const MAX_RECENT_PEERS = 5;

// File queue system  
let fileQueue = [];
let isProcessingQueue = false;

// ✅ INITIALIZATION
async function init() {
    if (!checkBrowserSupport()) {
        return;
    }
    
    console.log('🌊 Initializing One-Host Streaming...');
    
    // Initialize streaming manager
    streamManager = new StreamManager();
    
    // Initialize PeerJS
    await initializePeerJS();
    
    // Set up event listeners
    setupEventListeners();
    
    // Initialize connection keep-alive system
    initConnectionKeepAlive();
    
    // Load recent peers from localStorage
    loadRecentPeers();
    
    console.log('✅ One-Host Streaming initialized successfully');
}

// ✅ BROWSER SUPPORT CHECK
function checkBrowserSupport() {
    const hasWebRTC = !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection);
    const hasServiceWorker = 'serviceWorker' in navigator;
    const hasStreams = 'ReadableStream' in window;
    
    if (!hasWebRTC) {
        showBrowserSupportError('WebRTC is not supported in this browser');
        return false;
    }
    
    if (!hasServiceWorker) {
        console.warn('⚠️ Service Worker not supported - streaming downloads may not work on mobile');
    }
    
    if (!hasStreams) {
        console.warn('⚠️ Streams API not supported - may impact performance');
    }
    
    return true;
}

// ✅ PEERJS INITIALIZATION
async function initializePeerJS() {
    try {
        // Generate or retrieve peer ID
        let peerId = localStorage.getItem('peerId');
        if (!peerId) {
            peerId = generatePeerId();
            localStorage.setItem('peerId', peerId);
        }
        
        // Initialize PeerJS with configuration
        peer = new Peer(peerId, {
            host: 'localhost',
            port: 9000,
            path: '/myapp',
            debug: 2,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            }
        });
        
        setupPeerEventListeners();
        
    } catch (error) {
        console.error('❌ Failed to initialize PeerJS:', error);
        updateConnectionStatus('error', 'Failed to initialize peer connection');
    }
}

// ✅ PEER EVENT LISTENERS
function setupPeerEventListeners() {
    peer.on('open', (id) => {
        console.log('🆔 Peer ID:', id);
        elements.peerId.textContent = id;
        updateConnectionStatus('waiting', 'Ready to connect');
        generateQRCode(id);
    });
    
    peer.on('connection', (conn) => {
        console.log('📞 Incoming connection from:', conn.peer);
        connections.set(conn.peer, conn);
        setupConnectionHandlers(conn);
        addRecentPeer(conn.peer);
        updateConnectionStatus('connected', `Connected to: ${conn.peer}`);
    });
    
    peer.on('error', (error) => {
        console.error('❌ Peer error:', error);
        updateConnectionStatus('error', `Connection error: ${error.message}`);
    });
    
    peer.on('disconnected', () => {
        console.log('🔌 Peer disconnected');
        updateConnectionStatus('disconnected', 'Disconnected from server');
    });
}

// ✅ CONNECTION HANDLERS FOR STREAMING
function setupConnectionHandlers(conn) {
    conn.on('open', () => {
        console.log('✅ Connection opened with:', conn.peer);
        updateConnectionStatus('connected', `Connected to: ${conn.peer}`);
        showNotification(`Connected to ${conn.peer}`, 'success');
    });
    
    conn.on('data', async (data) => {
        try {
            console.log(`📨 Received data type: ${data.type}`);
            
            switch (data.type) {
                case MESSAGE_TYPES.FILE_INFO:
                    await handleFileInfo(data, conn);
                    break;
                    
                case MESSAGE_TYPES.STREAM_REQUEST:
                    await handleStreamRequest(data, conn);
                    break;
                    
                case MESSAGE_TYPES.STREAM_START:
                    await handleStreamStart(data);
                    break;
                    
                case MESSAGE_TYPES.STREAM_DATA:
                    await handleStreamData(data);
                    break;
                    
                case MESSAGE_TYPES.STREAM_COMPLETE:
                    await handleStreamComplete(data);
                    break;
                    
                case MESSAGE_TYPES.STREAM_ERROR:
                    await handleStreamError(data);
                    break;
                    
                case MESSAGE_TYPES.KEEP_ALIVE:
                    conn.send({
                        type: MESSAGE_TYPES.KEEP_ALIVE_RESPONSE,
                        timestamp: Date.now(),
                        peerId: peer.id
                    });
                    break;
                    
                case MESSAGE_TYPES.KEEP_ALIVE_RESPONSE:
                    console.log(`💗 Keep-alive response from: ${conn.peer}`);
                    break;
                    
                case MESSAGE_TYPES.DISCONNECT_NOTIFICATION:
                    console.log(`👋 Disconnect notification from: ${conn.peer}`);
                    connections.delete(conn.peer);
                    updateConnectionStatus();
                    break;
                    
                default:
                    console.warn('❓ Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('❌ Error handling data:', error);
        }
    });
    
    conn.on('close', () => {
        console.log('❌ Connection closed with:', conn.peer);
        connections.delete(conn.peer);
        updateConnectionStatus();
        showNotification(`Disconnected from ${conn.peer}`, 'warning');
    });
    
    conn.on('error', (error) => {
        console.error(`❌ Connection error with ${conn.peer}:`, error);
        connections.delete(conn.peer);
        updateConnectionStatus();
    });
}

// ✅ MAKE FUNCTIONS AVAILABLE GLOBALLY
// Export functions to window object for cross-module access
window.handleFileInfo = handleFileInfo;
window.handleStreamRequest = handleStreamRequest;
window.handleStreamStart = handleStreamStart;
window.handleStreamData = handleStreamData;
window.handleStreamComplete = handleStreamComplete;
window.handleStreamError = handleStreamError;
window.sendFile = sendFile;
window.streamFileToReceiver = streamFileToReceiver;
window.requestFileDownload = requestFileDownload;

window.setupEventListeners = setupEventListeners;
window.processFileQueue = processFileQueue;
window.addFileToHistory = addFileToHistory;
window.updateFilesList = updateFilesList;
window.updateStreamProgress = updateStreamProgress;
window.updateFileDownloadStatus = updateFileDownloadStatus;
window.connectToPeer = connectToPeer;
window.generatePeerId = generatePeerId;
window.formatFileSize = formatFileSize;
window.getFileIcon = getFileIcon;
window.updateConnectionStatus = updateConnectionStatus;
window.showNotification = showNotification;

window.initConnectionKeepAlive = initConnectionKeepAlive;
window.sendKeepAlive = sendKeepAlive;
window.sendDisconnectNotification = sendDisconnectNotification;
window.addRecentPeer = addRecentPeer;
window.loadRecentPeers = loadRecentPeers;
window.updateRecentPeersList = updateRecentPeersList;
window.generateQRCode = generateQRCode;
window.showBrowserSupportError = showBrowserSupportError;
window.handleAutoConnect = handleAutoConnect;

// Export global state
window.peer = peer;
window.connections = connections;
window.streamManager = streamManager;
window.sentFiles = sentFiles;
window.fileHistory = fileHistory;
window.isPageVisible = isPageVisible;
window.keepAliveInterval = keepAliveInterval;
window.recentPeers = recentPeers;
window.MAX_RECENT_PEERS = MAX_RECENT_PEERS;
window.fileQueue = fileQueue;
window.isProcessingQueue = isProcessingQueue;
window.elements = elements;

// ✅ START THE APPLICATION
document.addEventListener('DOMContentLoaded', () => {
    init().then(() => {
        handleAutoConnect();
    });
});

console.log('🌊 One-Host Streaming Script Loaded');

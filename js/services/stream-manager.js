/**
 * 🌊 STREAMING DOWNLOAD MANAGER
 * 
 * Coordinates between main thread, service worker, and WebRTC for
 * memory-efficient file downloads using browser's native download manager.
 */

class StreamManager {
    constructor() {
        this.activeStreams = new Map();
        this.streamProgressCallbacks = new Map();
        this.serviceWorkerReady = false;
        
        this.init();
    }
    
    async init() {
        // Check if service worker is available
        if ('serviceWorker' in navigator) {
            try {
                // Wait for service worker to be ready
                const registration = await navigator.serviceWorker.ready;
                this.serviceWorkerReady = true;
                
                // Listen for messages from service worker
                navigator.serviceWorker.addEventListener('message', (event) => {
                    this.handleServiceWorkerMessage(event);
                });
                
                console.log('🌊 StreamManager initialized with Service Worker support');
            } catch (error) {
                console.error('❌ Service Worker not available:', error);
                this.serviceWorkerReady = false;
            }
        } else {
            console.warn('⚠️ Service Worker not supported in this browser');
            this.serviceWorkerReady = false;
        }
    }
    
    // ✅ CREATE STREAMING DOWNLOAD URL
    createDownloadURL(fileId, filename, mimeType, size) {
        if (!this.serviceWorkerReady) {
            console.warn('⚠️ Service Worker not ready, cannot create stream URL');
            return null;
        }
        
        const streamInfo = {
            fileId,
            filename,
            mimeType,
            size,
            startTime: Date.now(),
            bytesReceived: 0,
            isActive: false
        };
        
        this.activeStreams.set(fileId, streamInfo);
        
        // Register stream with service worker
        this.sendToServiceWorker({
            type: 'register-stream',
            data: { fileId, filename, mimeType, size }
        });
        
        const streamURL = `/download/${fileId}`;
        console.log(`🔗 Created stream URL: ${streamURL} for file: ${filename}`);
        
        return streamURL;
    }
    
    // ✅ START DOWNLOAD WITH STREAMING URL
    async startDownload(fileId, filename) {
        const streamInfo = this.activeStreams.get(fileId);
        if (!streamInfo) {
            throw new Error(`Stream not found for fileId: ${fileId}`);
        }
        
        const downloadURL = `/download/${fileId}`;
        
        // Create download link and trigger download
        const link = document.createElement('a');
        link.href = downloadURL;
        link.download = filename;
        link.style.display = 'none';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        streamInfo.isActive = true;
        console.log(`🚀 Started download for: ${filename}`);
        
        return downloadURL;
    }
    
    // ✅ PIPE CHUNK DATA TO STREAM
    async pipeChunkToStream(fileId, chunkData, chunkIndex) {
        const streamInfo = this.activeStreams.get(fileId);
        if (!streamInfo) {
            console.warn(`⚠️ Stream not found for fileId: ${fileId}`);
            return false;
        }
        
        // Send chunk to service worker
        this.sendToServiceWorker({
            type: 'stream-chunk',
            data: { fileId, data: chunkData, chunkIndex }
        });
        
        // Update local stream info
        streamInfo.bytesReceived += chunkData.byteLength;
        streamInfo.lastChunkTime = Date.now();
        
        // Calculate progress
        const progress = streamInfo.size > 0 ? (streamInfo.bytesReceived / streamInfo.size) * 100 : 0;
        
        // Call progress callbacks
        const progressCallback = this.streamProgressCallbacks.get(fileId);
        if (progressCallback) {
            progressCallback({
                fileId,
                progress,
                bytesReceived: streamInfo.bytesReceived,
                totalBytes: streamInfo.size,
                chunkIndex
            });
        }
        
        console.log(`📦 Piped chunk ${chunkIndex} for ${fileId}: ${progress.toFixed(1)}%`);
        return true;
    }
    
    // ✅ COMPLETE STREAM
    async completeStream(fileId) {
        const streamInfo = this.activeStreams.get(fileId);
        if (!streamInfo) {
            console.warn(`⚠️ Stream not found for fileId: ${fileId}`);
            return;
        }
        
        // Notify service worker to close stream
        this.sendToServiceWorker({
            type: 'complete-stream',
            data: { fileId }
        });
        
        // Calculate final stats
        const duration = Date.now() - streamInfo.startTime;
        const speed = duration > 0 ? streamInfo.bytesReceived / (duration / 1000) : 0;
        
        console.log(`✅ Stream completed for ${fileId}: ${streamInfo.bytesReceived} bytes in ${duration}ms (${(speed / 1024 / 1024).toFixed(2)} MB/s)`);
        
        // Final progress callback
        const progressCallback = this.streamProgressCallbacks.get(fileId);
        if (progressCallback) {
            progressCallback({
                fileId,
                progress: 100,
                bytesReceived: streamInfo.bytesReceived,
                totalBytes: streamInfo.size,
                completed: true
            });
        }
        
        // Cleanup
        this.cleanupStream(fileId);
    }
    
    // ✅ CANCEL STREAM
    async cancelStream(fileId) {
        const streamInfo = this.activeStreams.get(fileId);
        if (!streamInfo) {
            return;
        }
        
        // Notify service worker to cancel stream
        this.sendToServiceWorker({
            type: 'cancel-stream',
            data: { fileId }
        });
        
        console.log(`❌ Stream cancelled for ${fileId}`);
        this.cleanupStream(fileId);
    }
    
    // ✅ SET PROGRESS CALLBACK
    setProgressCallback(fileId, callback) {
        this.streamProgressCallbacks.set(fileId, callback);
    }
    
    // ✅ CHECK IF STREAM IS ACTIVE
    isStreamActive(fileId) {
        const streamInfo = this.activeStreams.get(fileId);
        return streamInfo && streamInfo.isActive;
    }
    
    // ✅ GET STREAM INFO
    getStreamInfo(fileId) {
        return this.activeStreams.get(fileId);
    }
    
    // ✅ HANDLE SERVICE WORKER MESSAGES
    handleServiceWorkerMessage(event) {
        const { type, fileId } = event.data;
        
        switch (type) {
            case 'stream-ready':
                console.log(`🎯 Stream ready notification for fileId: ${fileId}`);
                const streamInfo = this.activeStreams.get(fileId);
                if (streamInfo) {
                    streamInfo.isActive = true;
                }
                break;
                
            default:
                console.log(`📨 Service Worker message: ${type}`, event.data);
        }
    }
    
    // ✅ SEND MESSAGE TO SERVICE WORKER
    sendToServiceWorker(message) {
        if (this.serviceWorkerReady && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage(message);
        } else {
            console.warn('⚠️ Service Worker not ready, cannot send message:', message);
        }
    }
    
    // ✅ CLEANUP STREAM
    cleanupStream(fileId) {
        this.activeStreams.delete(fileId);
        this.streamProgressCallbacks.delete(fileId);
        console.log(`🧹 Cleaned up stream: ${fileId}`);
    }
    
    // ✅ GET ALL ACTIVE STREAMS
    getAllActiveStreams() {
        return Array.from(this.activeStreams.values()).filter(stream => stream.isActive);
    }
    
    // ✅ CHECK SERVICE WORKER STATUS
    isServiceWorkerReady() {
        return this.serviceWorkerReady;
    }
}

// Export for use in main script
export { StreamManager };

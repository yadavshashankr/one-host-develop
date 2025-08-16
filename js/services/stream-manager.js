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
                // Register service worker if not already registered
                let registration;
                if (!navigator.serviceWorker.controller) {
                    console.log('🔄 Registering Service Worker...');
                    console.log('Current location:', window.location.href);
                    console.log('Current pathname:', window.location.pathname);
                    
                    // Determine the correct Service Worker path based on current location
                    const currentPath = window.location.pathname;
                    const basePath = currentPath.endsWith('/') ? currentPath : currentPath + '/';
                    console.log('Calculated base path:', basePath);
                    
                    // Try different paths for Service Worker registration
                    const swPaths = [
                        './service-worker.js',                           // Relative to current directory
                        'service-worker.js',                             // Same directory
                        basePath + 'service-worker.js',                  // Full base path
                        window.location.origin + basePath + 'service-worker.js'  // Absolute URL
                    ];
                    let registered = false;
                    
                    for (const swPath of swPaths) {
                        try {
                            console.log(`Trying Service Worker path: ${swPath}`);
                            registration = await navigator.serviceWorker.register(swPath);
                            console.log('✅ Service Worker registered successfully at:', swPath);
                            registered = true;
                            break;
                        } catch (pathError) {
                            console.warn(`Failed to register Service Worker at ${swPath}:`, pathError.message);
                        }
                    }
                    
                    if (!registered) {
                        throw new Error('Failed to register Service Worker at any path');
                    }
                } else {
                    console.log('✅ Service Worker already registered');
                    registration = await navigator.serviceWorker.ready;
                }
                
                // Wait for service worker to be ready
                await navigator.serviceWorker.ready;
                this.serviceWorkerReady = true;
                
                // Listen for messages from service worker
                navigator.serviceWorker.addEventListener('message', (event) => {
                    this.handleServiceWorkerMessage(event);
                });
                
                console.log('🌊 StreamManager initialized with Service Worker support');
            } catch (error) {
                console.error('❌ Service Worker initialization failed:', error);
                this.serviceWorkerReady = false;
            }
        } else {
            console.warn('⚠️ Service Worker not supported in this browser');
            this.serviceWorkerReady = false;
        }
    }
    
    // ✅ WAIT FOR SERVICE WORKER TO BE READY
    async waitForServiceWorker(timeout = 10000) {
        if (this.serviceWorkerReady) {
            return true;
        }
        
        console.log('⏳ Waiting for Service Worker to be ready...');
        
        const startTime = Date.now();
        while (!this.serviceWorkerReady && (Date.now() - startTime) < timeout) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (this.serviceWorkerReady) {
            console.log('✅ Service Worker is now ready');
            return true;
        } else {
            console.error('❌ Service Worker timeout after', timeout, 'ms');
            return false;
        }
    }
    
    // ✅ CREATE STREAMING DOWNLOAD URL
    async createDownloadURL(fileId, filename, mimeType, size) {
        // Wait for service worker to be ready
        const isReady = await this.waitForServiceWorker();
        if (!isReady) {
            console.error('❌ Service Worker not ready, cannot create stream URL');
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
        
        // Register stream with service worker and wait for confirmation
        await this.registerStreamWithServiceWorker(fileId, filename, mimeType, size);
        
        const streamURL = `/download/${fileId}`;
        console.log(`🔗 Created stream URL: ${streamURL} for file: ${filename}`);
        
        return streamURL;
    }
    
    // ✅ REGISTER STREAM WITH SERVICE WORKER AND WAIT FOR CONFIRMATION
    async registerStreamWithServiceWorker(fileId, filename, mimeType, size, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                console.error(`❌ Stream registration timeout for fileId: ${fileId}`);
                resolve(); // Don't reject, just continue - fallback behavior
            }, timeout);
            
            // Listen for registration confirmation
            const messageHandler = (event) => {
                if (event.data?.type === 'stream-registered' && event.data?.fileId === fileId) {
                    clearTimeout(timeoutId);
                    navigator.serviceWorker.removeEventListener('message', messageHandler);
                    console.log(`✅ Stream registration confirmed for: ${fileId}`);
                    resolve();
                }
            };
            
            navigator.serviceWorker.addEventListener('message', messageHandler);
            
            // Send registration request
            this.sendToServiceWorker({
                type: 'register-stream',
                data: { fileId, filename, mimeType, size }
            });
            
            console.log(`📝 Sent stream registration request for: ${fileId}`);
        });
    }
    
    // ✅ START DOWNLOAD WITH STREAMING URL
    async startDownload(fileId, filename) {
        // Wait for service worker to be ready
        const isReady = await this.waitForServiceWorker();
        if (!isReady) {
            throw new Error('Service Worker not ready for download');
        }
        
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

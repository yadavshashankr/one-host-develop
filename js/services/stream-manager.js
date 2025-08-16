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
        this.pendingDownloads = new Map(); // Store downloads waiting for chunks
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
                
                // Wait for service worker to be ready AND have a controller
                const swRegistration = await navigator.serviceWorker.ready;
                console.log('📋 Service Worker registration ready');
                
                // Check if we need to refresh to get the controller
                if (!navigator.serviceWorker.controller) {
                    console.log('⚠️ No Service Worker controller - page may need refresh');
                    console.log('🔄 Service Worker state:', swRegistration.active?.state);
                    
                    // Listen for controllerchange event
                    let controllerChangePromise = new Promise(resolve => {
                        navigator.serviceWorker.addEventListener('controllerchange', () => {
                            console.log('🎯 Service Worker controller changed!');
                            resolve();
                        }, { once: true });
                    });
                    
                    // Also listen for updatefound
                    if (swRegistration.installing) {
                        console.log('⏳ Service Worker installing, waiting for activation...');
                        swRegistration.installing.addEventListener('statechange', () => {
                            if (swRegistration.installing.state === 'activated') {
                                console.log('✅ Service Worker activated');
                            }
                        });
                    }
                    
                    // Wait for controller to be available (with timeout)
                    console.log('⏳ Waiting for Service Worker controller...');
                    let attempts = 0;
                    const maxAttempts = 100; // 10 seconds
                    
                    await new Promise((resolve) => {
                        const checkController = () => {
                            attempts++;
                            if (navigator.serviceWorker.controller) {
                                console.log('✅ Service Worker controller acquired');
                                resolve();
                            } else if (attempts >= maxAttempts) {
                                console.warn('⚠️ Service Worker controller not available after 10 seconds');
                                console.log('💡 Try refreshing the page to activate Service Worker');
                                resolve();
                            } else {
                                setTimeout(checkController, 100);
                            }
                        };
                        checkController();
                    });
                }
                
                // Only mark as ready if we have a controller
                this.serviceWorkerReady = !!navigator.serviceWorker.controller;
                
                if (this.serviceWorkerReady) {
                    console.log('✅ Service Worker controller is ready and available');
                } else {
                    console.warn('⚠️ Service Worker registered but no controller available');
                    console.log('🔄 This usually requires a page refresh to activate the Service Worker');
                    
                    // Auto-refresh if this is the first time (and we're not in an iframe)
                    if (window.top === window && !sessionStorage.getItem('sw-refresh-attempted')) {
                        console.log('🔄 Auto-refreshing page to activate Service Worker...');
                        sessionStorage.setItem('sw-refresh-attempted', 'true');
                        window.location.reload();
                        return; // Exit early since we're refreshing
                    }
                }
                
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
        return new Promise(async (resolve, reject) => {
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
            await this.sendToServiceWorker({
                type: 'register-stream',
                data: { fileId, filename, mimeType, size }
            });
            
            console.log(`📝 Sent stream registration request for: ${fileId}`);
        });
    }
    
    // ✅ START DOWNLOAD WITH BACKGROUND FETCH (Android Studio-like behavior)
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
        
        // Check if Background Fetch is supported
        if ('serviceWorker' in navigator && 'backgroundFetch' in ServiceWorkerRegistration.prototype) {
            console.log(`🎯 Background Fetch supported - but using regular download for debugging`);
            console.log(`📋 Using regular download method for better debugging`);
            
            // For now, use regular download to debug the streaming issue
            // TODO: Re-enable Background Fetch once streaming is working
            // await this.sendToServiceWorker({
            //     type: 'start-background-fetch',
            //     data: { fileId, filename, mimeType: streamInfo.mimeType, size: streamInfo.size }
            // });
            
        }
        
        // Use regular download for debugging (works for both Background Fetch supported and not)
        const downloadURL = `/download/${fileId}`;
        
        console.log(`🔗 Creating download link for: ${filename} -> ${downloadURL}`);
        
        const link = document.createElement('a');
        link.href = downloadURL;
        link.download = filename;
        link.style.display = 'none';
        
        document.body.appendChild(link);
        console.log(`👆 Triggering download link click for: ${filename}`);
        link.click();
        document.body.removeChild(link);
        
        streamInfo.isActive = true;
        streamInfo.usingBackgroundFetch = false;
        console.log(`🚀 Regular download started for: ${filename} (URL: ${downloadURL})`);
        
        return downloadURL;
    }
    
    // ✅ FALLBACK REGULAR DOWNLOAD METHOD
    startRegularDownload(fileId, filename) {
        const downloadURL = `/download/${fileId}`;
        
        const link = document.createElement('a');
        link.href = downloadURL;
        link.download = filename;
        link.style.display = 'none';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        const streamInfo = this.activeStreams.get(fileId);
        if (streamInfo) {
            streamInfo.isActive = true;
            streamInfo.usingBackgroundFetch = false;
        }
        
        console.log(`🚀 Fallback regular download started for: ${filename}`);
    }
    
    // ✅ PIPE CHUNK DATA TO STREAM
    async pipeChunkToStream(fileId, chunkData, chunkIndex) {
        const streamInfo = this.activeStreams.get(fileId);
        if (!streamInfo) {
            console.warn(`⚠️ Stream not found for fileId: ${fileId}`);
            return false;
        }
        
        // Send chunk to service worker
        const sent = await this.sendToServiceWorker({
            type: 'stream-chunk',
            data: { fileId, data: chunkData, chunkIndex }
        });
        
        if (!sent) {
            console.error('❌ Failed to send chunk to Service Worker');
            return false;
        }
        
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
        await this.sendToServiceWorker({
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
        
        // 🎯 CRITICAL: Now trigger the pending download since all chunks are ready
        await this.triggerPendingDownload(fileId);
        
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
                
            case 'service-worker-heartbeat':
                // Respond to Service Worker heartbeat to keep it alive
                this.sendToServiceWorker({
                    type: 'keep-alive',
                    data: { timestamp: Date.now() }
                });
                break;
                
            case 'background-fetch-started':
                console.log(`🎯 Background Fetch started for: ${event.data.filename}`);
                // Update UI to show native download has started
                if (window.updateFileDownloadStatus) {
                    window.updateFileDownloadStatus(event.data.fileId, 'downloading-native', 0);
                }
                break;
                
            case 'background-fetch-success':
                console.log(`✅ Background Fetch completed for: ${fileId}`);
                const completedStream = this.activeStreams.get(fileId);
                if (completedStream) {
                    if (window.updateFileDownloadStatus) {
                        window.updateFileDownloadStatus(fileId, 'completed', 100);
                    }
                    if (window.showNotification) {
                        window.showNotification(`✅ Download completed: ${completedStream.filename}`, 'success');
                    }
                }
                break;
                
            case 'background-fetch-fail':
                console.log(`❌ Background Fetch failed for: ${fileId}`);
                if (window.updateFileDownloadStatus) {
                    window.updateFileDownloadStatus(fileId, 'error', 0);
                }
                if (window.showNotification) {
                    window.showNotification(`❌ Download failed: ${fileId}`, 'error');
                }
                break;
                
            case 'background-fetch-abort':
                console.log(`⏹️ Background Fetch aborted for: ${fileId}`);
                if (window.updateFileDownloadStatus) {
                    window.updateFileDownloadStatus(fileId, 'cancelled', 0);
                }
                break;
                
            case 'background-fetch-fallback':
                console.log(`📋 Falling back to regular download for: ${event.data.filename}`);
                // Trigger regular download as fallback
                const fallbackStream = this.activeStreams.get(event.data.fileId);
                if (fallbackStream) {
                    this.startRegularDownload(event.data.fileId, event.data.filename);
                }
                break;
                
            default:
                console.log(`📨 Service Worker message: ${type}`, event.data);
        }
    }
    
    // ✅ SEND MESSAGE TO SERVICE WORKER
    async sendToServiceWorker(message) {
        // Ensure Service Worker is ready before sending
        if (!this.serviceWorkerReady) {
            console.log('⏳ Service Worker not ready, waiting...');
            await this.waitForServiceWorker();
        }
        
        if (this.serviceWorkerReady && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage(message);
            return true;
        } else {
            console.error('❌ Service Worker still not ready after waiting, cannot send message:', message);
            return false;
        }
    }
    
    // ✅ SET PENDING DOWNLOAD (wait for chunks before triggering)
    setPendingDownload(fileId, downloadInfo) {
        this.pendingDownloads.set(fileId, downloadInfo);
        console.log(`📋 Pending download registered: ${downloadInfo.fileName}`);
    }
    
    // ✅ TRIGGER DOWNLOAD WHEN CHUNKS COMPLETE
    async triggerPendingDownload(fileId) {
        const downloadInfo = this.pendingDownloads.get(fileId);
        if (!downloadInfo) {
            console.warn(`⚠️ No pending download found for fileId: ${fileId}`);
            return;
        }
        
        console.log(`🚀 Triggering download now that chunks are complete: ${downloadInfo.fileName}`);
        
        try {
            // Now that chunks are ready, start the actual download
            await this.startDownload(fileId, downloadInfo.fileName);
            
            // Remove from pending downloads
            this.pendingDownloads.delete(fileId);
            
            console.log(`✅ Download triggered successfully: ${downloadInfo.fileName}`);
            
        } catch (error) {
            console.error(`❌ Failed to trigger download for ${downloadInfo.fileName}:`, error);
            this.pendingDownloads.delete(fileId);
        }
    }
    
    // ✅ CLEANUP STREAM
    cleanupStream(fileId) {
        this.activeStreams.delete(fileId);
        this.streamProgressCallbacks.delete(fileId);
        this.pendingDownloads.delete(fileId); // Also cleanup pending downloads
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

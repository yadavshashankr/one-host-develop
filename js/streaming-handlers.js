/**
 * 🌊 STREAMING MESSAGE HANDLERS
 * Core functions for handling streaming protocol messages
 */

// ✅ NEW STREAMING MESSAGE HANDLERS

// Handle file info (metadata)
export async function handleFileInfo(data, conn) {
    const { fileId, fileName, fileType, fileSize, originalSender } = data;
    
    console.log(`📄 Received file info: ${fileName} (${formatFileSize(fileSize)})`);
    
    const fileInfo = {
        id: fileId,
        name: fileName,
        type: fileType,
        size: fileSize,
        sharedBy: originalSender || conn.peer,
        timestamp: Date.now()
    };
    
    // Add to received files list
    if (!window.fileHistory.received.has(fileId)) {
        window.addFileToHistory(fileInfo, 'received');
        window.showNotification(`📥 Received: ${fileName}`, 'info');
    }
}

// Handle stream request (receiver wants to download)
export async function handleStreamRequest(data, conn) {
    const { fileId, fileName } = data;
    
    console.log(`🌊 Stream request for: ${fileName} (${fileId})`);
    
    const file = window.sentFiles.get(fileId);
    if (!file) {
        conn.send({
            type: 'stream-error',
            fileId,
            error: 'File not found'
        });
        return;
    }
    
    // Start streaming the file
    await streamFileToReceiver(file, fileId, conn);
}

// Handle stream start notification
export async function handleStreamStart(data) {
    const { fileId, fileName, totalChunks } = data;
    
    console.log(`🚀 Stream starting: ${fileName} (${totalChunks} chunks)`);
    
    // Set up progress tracking
    const progressCallback = (progressData) => {
        window.updateStreamProgress(fileId, progressData);
    };
    
    window.streamManager.setProgressCallback(fileId, progressCallback);
    
    // Update UI to show download starting
    window.updateFileDownloadStatus(fileId, 'downloading', 0);
}

// Handle stream data chunk
export async function handleStreamData(data) {
    const { fileId, chunkIndex, chunkData } = data;
    
    // Pipe chunk to stream manager
    await window.streamManager.pipeChunkToStream(fileId, chunkData, chunkIndex);
}

// Handle stream completion
export async function handleStreamComplete(data) {
    const { fileId, fileName } = data;
    
    console.log(`✅ Stream completed: ${fileName}`);
    
    // Complete the stream
    await window.streamManager.completeStream(fileId);
    
    // Update UI
    window.updateFileDownloadStatus(fileId, 'completed', 100);
    window.showNotification(`✅ Downloaded: ${fileName}`, 'success');
}

// Handle stream error
export async function handleStreamError(data) {
    const { fileId, error } = data;
    
    console.error(`❌ Stream error for ${fileId}:`, error);
    
    // Cancel the stream
    await window.streamManager.cancelStream(fileId);
    
    // Update UI
    window.updateFileDownloadStatus(fileId, 'error', 0);
    window.showNotification(`❌ Download failed: ${error}`, 'error');
}

// ✅ FILE SENDING WITH STREAMING
export async function sendFile(file) {
    if (window.connections.size === 0) {
        window.showNotification('No connected peers to send file to', 'error');
        return;
    }
    
    const fileId = `${file.name}-${Date.now()}`;
    
    // Store file for streaming
    window.sentFiles.set(fileId, file);
    
    // Add to sent files history
    const fileInfo = {
        id: fileId,
        name: file.name,
        type: file.type,
        size: file.size,
        timestamp: Date.now()
    };
    
    window.addFileToHistory(fileInfo, 'sent');
    
    // Send file info to all connected peers
    const fileInfoMessage = {
        type: 'file-info',
        fileId,
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        originalSender: window.peer.id,
        timestamp: Date.now()
    };
    
    for (const [peerId, conn] of window.connections) {
        if (conn.open) {
            try {
                conn.send(fileInfoMessage);
                console.log(`📤 Sent file info to: ${peerId}`);
            } catch (error) {
                console.error(`❌ Failed to send file info to ${peerId}:`, error);
            }
        }
    }
    
    window.showNotification(`📤 File shared: ${file.name}`, 'success');
}

// ✅ STREAM FILE TO RECEIVER
export async function streamFileToReceiver(file, fileId, conn) {
    try {
        const STREAM_CHUNK_SIZE = 64 * 1024; // 64KB chunks
        const totalChunks = Math.ceil(file.size / STREAM_CHUNK_SIZE);
        
        // Notify stream start
        conn.send({
            type: 'stream-start',
            fileId,
            fileName: file.name,
            totalChunks,
            chunkSize: STREAM_CHUNK_SIZE
        });
        
        console.log(`🌊 Starting stream: ${file.name} (${totalChunks} chunks)`);
        
        // Stream file in chunks
        let offset = 0;
        let chunkIndex = 0;
        
        while (offset < file.size) {
            if (!conn.open) {
                throw new Error('Connection closed during streaming');
            }
            
            const chunkEnd = Math.min(offset + STREAM_CHUNK_SIZE, file.size);
            const chunk = file.slice(offset, chunkEnd);
            const arrayBuffer = await chunk.arrayBuffer();
            
            // Send chunk
            conn.send({
                type: 'stream-data',
                fileId,
                chunkIndex,
                chunkData: arrayBuffer
            });
            
            console.log(`📦 Sent chunk ${chunkIndex}/${totalChunks} (${arrayBuffer.byteLength} bytes)`);
            
            offset = chunkEnd;
            chunkIndex++;
            
            // Small delay to prevent overwhelming the connection
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        
        // Notify stream completion
        conn.send({
            type: 'stream-complete',
            fileId,
            fileName: file.name
        });
        
        console.log(`✅ Stream completed: ${file.name}`);
        
    } catch (error) {
        console.error(`❌ Streaming error:`, error);
        
        conn.send({
            type: 'stream-error',
            fileId,
            error: error.message
        });
    }
}

// ✅ REQUEST FILE DOWNLOAD (NEW STREAMING APPROACH)
export async function requestFileDownload(fileInfo) {
    try {
        console.log(`🎯 Requesting download: ${fileInfo.name}`);
        
        // Create streaming download URL
        const streamURL = window.streamManager.createDownloadURL(
            fileInfo.id,
            fileInfo.name,
            fileInfo.type,
            fileInfo.size
        );
        
        if (!streamURL) {
            throw new Error('Unable to create streaming download URL');
        }
        
        // Start the download
        await window.streamManager.startDownload(fileInfo.id, fileInfo.name);
        
        // Find connection to sender
        const conn = window.connections.get(fileInfo.sharedBy);
        if (!conn || !conn.open) {
            throw new Error('No connection to file sender');
        }
        
        // Request stream from sender
        conn.send({
            type: 'stream-request',
            fileId: fileInfo.id,
            fileName: fileInfo.name
        });
        
        console.log(`📡 Stream request sent to: ${fileInfo.sharedBy}`);
        
    } catch (error) {
        console.error('❌ Download request failed:', error);
        window.showNotification(`Download failed: ${error.message}`, 'error');
    }
}

// Utility function
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

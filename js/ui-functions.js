/**
 * 🎨 UI FUNCTIONS
 * User interface management and event handlers
 */

// ✅ EVENT LISTENERS SETUP
export function setupEventListeners() {
    const elements = window.elements;
    
    // Copy peer ID
    elements.copyId.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(window.peer.id);
            window.showNotification('Peer ID copied to clipboard', 'success');
        } catch (error) {
            console.error('Failed to copy peer ID:', error);
            window.showNotification('Failed to copy peer ID', 'error');
        }
    });
    
    // Share peer ID
    elements.shareId.addEventListener('click', async () => {
        if (navigator.share) {
            try {
                await navigator.share({
                    title: 'One-Host Connection',
                    text: `Connect to me on One-Host with ID: ${window.peer.id}`,
                    url: window.location.href
                });
            } catch (error) {
                console.log('Share cancelled or failed:', error);
            }
        } else {
            // Fallback to copy
            await navigator.clipboard.writeText(window.peer.id);
            window.showNotification('Peer ID copied (sharing not supported)', 'info');
        }
    });
    
    // Connect to peer
    elements.connectButton.addEventListener('click', () => {
        const remotePeerId = elements.remotePeerId.value.trim();
        if (remotePeerId && remotePeerId !== window.peer.id) {
            window.connectToPeer(remotePeerId);
        } else {
            window.showNotification('Please enter a valid peer ID', 'error');
        }
    });
    
    // Enter key for connection
    elements.remotePeerId.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            elements.connectButton.click();
        }
    });
    
    // File input and drop zone
    elements.dropZone.addEventListener('click', () => {
        if (window.connections.size > 0) {
            elements.fileInput.click();
        } else {
            window.showNotification('Please connect to at least one peer first', 'error');
        }
    });
    
    elements.fileInput.addEventListener('change', (e) => {
        if (window.connections.size > 0) {
            const files = Array.from(e.target.files);
            if (files.length > 0) {
                files.forEach(file => window.fileQueue.push(file));
                window.processFileQueue();
            }
            e.target.value = ''; // Reset for reselection
        } else {
            window.showNotification('Please connect to at least one peer first', 'error');
        }
    });
    
    // Drag and drop
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
        
        if (window.connections.size > 0) {
            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) {
                files.forEach(file => window.fileQueue.push(file));
                window.processFileQueue();
            }
        } else {
            window.showNotification('Please connect to at least one peer first', 'error');
        }
    });
}

// ✅ FILE QUEUE PROCESSING
export async function processFileQueue() {
    if (window.isProcessingQueue || window.fileQueue.length === 0) return;
    
    window.isProcessingQueue = true;
    
    while (window.fileQueue.length > 0) {
        const file = window.fileQueue.shift();
        try {
            await window.sendFile(file);
            await new Promise(resolve => setTimeout(resolve, 100)); // Brief delay
        } catch (error) {
            console.error('Error processing file:', error);
            window.showNotification(`Failed to send ${file.name}: ${error.message}`, 'error');
        }
    }
    
    window.isProcessingQueue = false;
}

// ✅ UI UPDATE FUNCTIONS

export function addFileToHistory(fileInfo, type) {
    if (type === 'sent') {
        window.fileHistory.sent.add(fileInfo.id);
        updateFilesList(window.elements.sentFilesList, fileInfo, 'sent');
    } else {
        window.fileHistory.received.add(fileInfo.id);
        updateFilesList(window.elements.receivedFilesList, fileInfo, 'received');
    }
}

export function updateFilesList(listElement, fileInfo, type) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.setAttribute('data-file-id', fileInfo.id);
    
    // File icon
    const icon = document.createElement('div');
    icon.className = 'file-icon';
    icon.innerHTML = `<span class="material-icons">${getFileIcon(fileInfo.type)}</span>`;
    
    // File info
    const info = document.createElement('div');
    info.className = 'file-info';
    
    const nameSpan = document.createElement('div');
    nameSpan.className = 'file-name';
    nameSpan.textContent = fileInfo.name;
    
    const sizeSpan = document.createElement('div');
    sizeSpan.className = 'file-size';
    sizeSpan.textContent = formatFileSize(fileInfo.size);
    
    const sharedBySpan = document.createElement('div');
    sharedBySpan.className = 'shared-by';
    sharedBySpan.textContent = type === 'sent' ? 'Sent by you' : `Shared by ${fileInfo.sharedBy}`;
    
    info.appendChild(nameSpan);
    info.appendChild(sizeSpan);
    info.appendChild(sharedBySpan);
    
    // Download button
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'icon-button download-btn';
    downloadBtn.title = 'Download file';
    downloadBtn.innerHTML = '<span class="material-icons">download</span>';
    
    downloadBtn.onclick = async () => {
        try {
            if (type === 'sent') {
                // For sent files, create blob URL (local file)
                const file = window.sentFiles.get(fileInfo.id);
                if (file) {
                    const url = URL.createObjectURL(file);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = fileInfo.name;
                    a.click();
                    URL.revokeObjectURL(url);
                }
            } else {
                // For received files, use streaming download
                downloadBtn.innerHTML = '<span class="loading-spinner"></span>';
                downloadBtn.disabled = true;
                
                await window.requestFileDownload(fileInfo);
                
                downloadBtn.innerHTML = '<span class="material-icons">download</span>';
                downloadBtn.disabled = false;
            }
        } catch (error) {
            console.error('Download error:', error);
            window.showNotification(`Download failed: ${error.message}`, 'error');
            downloadBtn.innerHTML = '<span class="material-icons">download</span>';
            downloadBtn.disabled = false;
        }
    };
    
    li.appendChild(icon);
    li.appendChild(info);
    li.appendChild(downloadBtn);
    
    // Add to beginning of list
    if (listElement.firstChild) {
        listElement.insertBefore(li, listElement.firstChild);
    } else {
        listElement.appendChild(li);
    }
    
    // Scroll new received files into view
    if (type === 'received') {
        setTimeout(() => {
            li.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
    }
}

export function updateStreamProgress(fileId, progressData) {
    const { progress, bytesReceived, totalBytes } = progressData;
    
    const listItem = document.querySelector(`[data-file-id="${fileId}"]`);
    if (listItem) {
        const downloadBtn = listItem.querySelector('.download-btn');
        if (downloadBtn && !progressData.completed) {
            downloadBtn.innerHTML = `${Math.round(progress)}%`;
            downloadBtn.disabled = true;
        } else if (progressData.completed) {
            downloadBtn.innerHTML = '<span class="material-icons">check_circle</span>';
            downloadBtn.disabled = false;
            downloadBtn.title = 'Download completed';
        }
    }
    
    console.log(`📊 Progress: ${fileId} - ${progress.toFixed(1)}% (${formatFileSize(bytesReceived)}/${formatFileSize(totalBytes)})`);
}

export function updateFileDownloadStatus(fileId, status, progress) {
    const listItem = document.querySelector(`[data-file-id="${fileId}"]`);
    if (!listItem) return;
    
    const downloadBtn = listItem.querySelector('.download-btn');
    if (!downloadBtn) return;
    
    switch (status) {
        case 'downloading':
            downloadBtn.innerHTML = `${Math.round(progress)}%`;
            downloadBtn.disabled = true;
            listItem.classList.add('downloading');
            break;
            
        case 'completed':
            downloadBtn.innerHTML = '<span class="material-icons">check_circle</span>';
            downloadBtn.disabled = false;
            downloadBtn.title = 'Download completed';
            listItem.classList.remove('downloading');
            listItem.classList.add('completed');
            break;
            
        case 'error':
            downloadBtn.innerHTML = '<span class="material-icons">error</span>';
            downloadBtn.disabled = false;
            downloadBtn.title = 'Download failed - click to retry';
            listItem.classList.remove('downloading');
            listItem.classList.add('error');
            break;
    }
}

// ✅ UTILITY FUNCTIONS

export function connectToPeer(remotePeerId) {
    if (window.connections.has(remotePeerId)) {
        window.showNotification('Already connected to this peer', 'info');
        return;
    }
    
    console.log('🔗 Connecting to peer:', remotePeerId);
    
    const conn = window.peer.connect(remotePeerId, { reliable: true });
    window.connections.set(remotePeerId, conn);
    
    window.setupConnectionHandlers(conn);
    window.addRecentPeer(remotePeerId);
    
    window.updateConnectionStatus('connecting', `Connecting to ${remotePeerId}...`);
    
    conn.on('open', () => {
        window.elements.remotePeerId.value = '';
        window.showNotification(`Connected to ${remotePeerId}`, 'success');
    });
}

export function generatePeerId() {
    return Math.random().toString(36).substr(2, 9);
}

export function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function getFileIcon(mimeType) {
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

export function updateConnectionStatus(status = '', message = '') {
    const statusColors = {
        'waiting': '#ffa726',
        'connecting': '#42a5f5',
        'connected': '#66bb6a',
        'error': '#ef5350',
        'disconnected': '#bdbdbd'
    };
    
    if (status) {
        window.elements.statusDot.style.backgroundColor = statusColors[status] || '#bdbdbd';
        window.elements.statusText.textContent = message;
    } else {
        // Auto-detect status based on connections
        if (window.connections.size > 0) {
            window.elements.statusDot.style.backgroundColor = statusColors.connected;
            window.elements.statusText.textContent = `Connected to ${window.connections.size} peer(s)`;
        } else {
            window.elements.statusDot.style.backgroundColor = statusColors.waiting;
            window.elements.statusText.textContent = 'Ready to connect';
        }
    }
}

// ✅ NOTIFICATION SYSTEM
export function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    window.elements.notifications.appendChild(notification);
    
    // Auto-remove after 5 seconds
    setTimeout(() => {
        notification.classList.add('fade-out');
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 300);
    }, 5000);
}

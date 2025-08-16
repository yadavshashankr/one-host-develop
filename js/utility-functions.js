/**
 * 🔧 UTILITY FUNCTIONS
 * Helper functions for connection management, keep-alive, and other utilities
 */

// ✅ CONNECTION KEEP-ALIVE SYSTEM
export function initConnectionKeepAlive() {
    const KEEP_ALIVE_INTERVAL = 30000; // 30 seconds
    
    window.keepAliveInterval = setInterval(() => {
        if (window.connections.size > 0 && window.isPageVisible) {
            sendKeepAlive();
        }
    }, KEEP_ALIVE_INTERVAL);
    
    // Handle visibility changes
    document.addEventListener('visibilitychange', () => {
        window.isPageVisible = !document.hidden;
    });
    
    // Handle page unload
    window.addEventListener('beforeunload', () => {
        sendDisconnectNotification();
    });
}

export function sendKeepAlive() {
    const keepAliveData = {
        type: 'keep-alive',
        timestamp: Date.now(),
        peerId: window.peer.id
    };
    
    for (const [peerId, conn] of window.connections) {
        if (conn && conn.open) {
            try {
                conn.send(keepAliveData);
            } catch (error) {
                console.error(`Failed to send keep-alive to ${peerId}:`, error);
            }
        }
    }
}

export function sendDisconnectNotification() {
    const disconnectData = {
        type: 'disconnect-notification',
        peerId: window.peer.id
    };
    
    for (const [peerId, conn] of window.connections) {
        if (conn && conn.open) {
            try {
                conn.send(disconnectData);
            } catch (error) {
                console.error(`Failed to send disconnect notification to ${peerId}:`, error);
            }
        }
    }
}

// ✅ RECENT PEERS MANAGEMENT
export function addRecentPeer(peerId) {
    if (peerId === window.peer.id) return;
    
    // Remove if already exists
    window.recentPeers = window.recentPeers.filter(id => id !== peerId);
    
    // Add to beginning
    window.recentPeers.unshift(peerId);
    
    // Limit to MAX_RECENT_PEERS
    if (window.recentPeers.length > window.MAX_RECENT_PEERS) {
        window.recentPeers = window.recentPeers.slice(0, window.MAX_RECENT_PEERS);
    }
    
    // Save to localStorage
    localStorage.setItem('recentPeers', JSON.stringify(window.recentPeers));
    
    // Update UI
    updateRecentPeersList();
}

export function loadRecentPeers() {
    try {
        const saved = localStorage.getItem('recentPeers');
        if (saved) {
            window.recentPeers = JSON.parse(saved);
            updateRecentPeersList();
        }
    } catch (error) {
        console.error('Failed to load recent peers:', error);
        window.recentPeers = [];
    }
}

export function updateRecentPeersList() {
    window.elements.recentPeersList.innerHTML = '';
    
    if (window.recentPeers.length === 0) {
        window.elements.recentPeers.style.display = 'none';
        return;
    }
    
    window.elements.recentPeers.style.display = 'block';
    
    window.recentPeers.forEach(peerId => {
        const li = document.createElement('li');
        li.className = 'recent-peer-item';
        li.textContent = peerId;
        li.onclick = () => {
            window.elements.remotePeerId.value = peerId;
            window.connectToPeer(peerId);
        };
        window.elements.recentPeersList.appendChild(li);
    });
}

// ✅ QR CODE GENERATION
export function generateQRCode(peerId) {
    const qrData = `${window.location.origin}?connect=${peerId}`;
    
    if (typeof QRCode !== 'undefined') {
        window.elements.qrcode.innerHTML = '';
        new QRCode(window.elements.qrcode, {
            text: qrData,
            width: 200,
            height: 200,
            colorDark: '#000000',
            colorLight: '#ffffff'
        });
    }
}

// ✅ BROWSER SUPPORT ERROR
export function showBrowserSupportError(message) {
    window.elements.browserSupport.style.display = 'block';
    window.elements.fileTransferSection.style.display = 'none';
    
    const errorMsg = window.elements.browserSupport.querySelector('.error-message');
    if (errorMsg) {
        errorMsg.textContent = message;
    }
}

// ✅ AUTO-CONNECT FROM URL
export function handleAutoConnect() {
    const urlParams = new URLSearchParams(window.location.search);
    const connectId = urlParams.get('connect');
    
    if (connectId && connectId !== window.peer.id) {
        setTimeout(() => {
            window.elements.remotePeerId.value = connectId;
            window.connectToPeer(connectId);
        }, 1000);
    }
}

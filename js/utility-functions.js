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
    try {
        if (!window.elements.qrcode) return;
        window.elements.qrcode.innerHTML = ''; // Clear previous QR code
        
        // Generate URL with peer ID as query parameter
        const baseUrl = window.location.origin + window.location.pathname;
        const qrUrl = `${baseUrl}?peer=${peerId}`;
        
        if (typeof QRCode !== 'undefined') {
            new QRCode(window.elements.qrcode, {
                text: qrUrl,
                width: 128,
                height: 128,
                colorDark: '#2196F3',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.H
            });
        }
    } catch (error) {
        console.error('QR Code Generation Error:', error);
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
    const connectId = urlParams.get('connect') || urlParams.get('peer');
    
    if (connectId && connectId !== window.peer.id) {
        setTimeout(() => {
            window.elements.remotePeerId.value = connectId;
            window.connectToPeer(connectId);
        }, 1000);
    }
}

// ✅ PEER ID EDITING FUNCTIONALITY
export function initPeerIdEditing() {
    if (window.elements.editIdButton) {
        window.elements.editIdButton.addEventListener('click', startEditingPeerId);
    }
    if (window.elements.saveIdButton) {
        window.elements.saveIdButton.addEventListener('click', saveEditedPeerId);
    }
    if (window.elements.cancelEditButton) {
        window.elements.cancelEditButton.addEventListener('click', cancelEditingPeerId);
    }
    if (window.elements.peerIdEdit) {
        window.elements.peerIdEdit.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                saveEditedPeerId();
            } else if (e.key === 'Escape') {
                cancelEditingPeerId();
            }
        });
    }
}

function startEditingPeerId() {
    if (!window.peer || window.connections.size > 0) return; // Can't edit when connected
    
    const currentId = window.peer.id;
    window.elements.peerIdEdit.value = currentId;
    window.elements.peerId.style.display = 'none';
    window.elements.peerIdEdit.style.display = 'inline';
    window.elements.editIdButton.style.display = 'none';
    window.elements.saveIdButton.style.display = 'inline';
    window.elements.cancelEditButton.style.display = 'inline';
    window.elements.peerIdEdit.focus();
}

function saveEditedPeerId() {
    const newPeerId = window.elements.peerIdEdit.value.trim();
    
    if (!newPeerId || newPeerId === window.peer.id) {
        cancelEditingPeerId();
        return;
    }
    
    // Update peer ID
    window.updateConnectionStatus('connecting', 'Updating peer ID...');
    
    try {
        // Destroy current peer and create new one
        if (window.peer) {
            window.peer.destroy();
        }
        
        // Create new peer with custom ID
        const newPeer = new Peer(newPeerId, {
            debug: 2,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            }
        });
        
        newPeer.on('open', (id) => {
            window.peer = newPeer;
            window.elements.peerId.textContent = id;
            window.generateQRCode(id);
            localStorage.setItem('peerId', id);
            window.updateConnectionStatus('', 'Ready to connect');
            cancelEditingPeerId();
            window.setupPeerEventListeners();
        });
        
        newPeer.on('error', (error) => {
            console.error('Error updating peer ID:', error);
            window.updateConnectionStatus('', 'Failed to update peer ID');
            cancelEditingPeerId();
        });
        
    } catch (error) {
        console.error('Error updating peer ID:', error);
        window.updateConnectionStatus('', 'Failed to update peer ID');
        cancelEditingPeerId();
    }
}

function cancelEditingPeerId() {
    window.elements.peerId.style.display = 'inline';
    window.elements.peerIdEdit.style.display = 'none';
    window.elements.editIdButton.style.display = 'inline';
    window.elements.saveIdButton.style.display = 'none';
    window.elements.cancelEditButton.style.display = 'none';
}

// ✅ SOCIAL MEDIA TOGGLE FUNCTIONALITY
export function initSocialMediaToggle() {
    console.log('Initializing social media toggle...');
    
    if (window.elements.socialToggle && window.elements.socialIcons) {
        console.log('Social media elements found, adding event listeners...');
        
        window.elements.socialToggle.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            console.log('Social toggle clicked!');
            
            window.elements.socialIcons.classList.toggle('show');
            console.log('Social icons show class:', window.elements.socialIcons.classList.contains('show'));
        });

        // Close social media menu when clicking outside
        document.addEventListener('click', function(event) {
            if (!window.elements.socialToggle.contains(event.target) && 
                !window.elements.socialIcons.contains(event.target)) {
                window.elements.socialIcons.classList.remove('show');
            }
        });
        
        console.log('Social media toggle initialized successfully!');
    } else {
        console.error('Social media elements not found!');
    }
}

// Reconnection Manager Service
// Handles reconnection to tracked peers with tried flag logic

class ReconnectionManager {
    constructor(sessionStateManager, peer, connections, setupConnectionHandlers, updateConnectionStatus, elements, CONNECTION_TIMEOUT) {
        this.sessionStateManager = sessionStateManager;
        this.peer = peer;
        this.connections = connections;
        this.setupConnectionHandlers = setupConnectionHandlers;
        this.updateConnectionStatus = updateConnectionStatus;
        this.elements = elements;
        this.CONNECTION_TIMEOUT = CONNECTION_TIMEOUT;
        
        this.isReconnecting = false;
    }
    
    // Reconnect to tracked peers
    async reconnectToPeers(peerIds) {
        // Prevent duplicate reconnection attempts
        if (this.isReconnecting) {
            console.log('ℹ️ Reconnection already in progress, skipping');
            return;
        }
        
        if (!peerIds || peerIds.length === 0) {
            console.log('ℹ️ No peer IDs provided for reconnection');
            return;
        }
        
        // Check if peer is available
        if (!this.peer || this.peer.destroyed) {
            console.log('ℹ️ Peer not available, cannot reconnect');
            this.isReconnecting = false; // Reset flag
            return;
        }
        
        // Check if peer is open (ready to make connections)
        // If not open, we'll wait a bit and check again, but don't set isReconnecting yet
        if (!this.peer.open) {
            console.log('ℹ️ Peer not open yet, will retry reconnection after peer opens');
            // Don't set isReconnecting flag yet, let the peer.on('open') handler trigger reconnection
            // when the peer becomes available
            return;
        }
        
        // Set reconnection flag
        this.isReconnecting = true;
        
        // Keep file transfer section visible during reconnection
        if (this.elements.fileTransferSection) {
            this.elements.fileTransferSection.classList.remove('hidden');
            console.log('📁 File transfer section kept visible during reconnection');
        }
        
        // Update status to "Connecting..."
        this.updateConnectionStatus('connecting', 'Connecting...');
        
        console.log(`🔄 Reconnecting to ${peerIds.length} tracked peer(s):`, peerIds);
        
        let connectedCount = 0;
        const connectionPromises = [];
        
        for (const peerId of peerIds) {
            // Skip if already connected
            if (this.connections.has(peerId)) {
                const existingConn = this.connections.get(peerId);
                if (existingConn && existingConn.open) {
                    connectedCount++;
                    console.log(`✅ Already connected to ${peerId}`);
                    // Reset tried flag since connection is active
                    this.sessionStateManager.resetPeerTried(peerId);
                    continue;
                } else {
                    this.connections.delete(peerId);
                }
            }
            
            // Skip self
            if (peerId === this.peer.id) {
                continue;
            }
            
            // Create connection promise
            const connectPromise = this.createConnectionPromise(peerId);
            connectionPromises.push(connectPromise);
            
            // Small delay between connection attempts
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        // Wait for all connection attempts to complete
        await Promise.allSettled(connectionPromises);
        
        // Clear reconnection flag
        this.isReconnecting = false;
        
        // Update final status
        if (connectedCount > 0) {
            // Reset reconnection flag before updating status to avoid triggering reconnection again
            this.isReconnecting = false;
            this.updateConnectionStatus('connected', `Connected to peer(s) : ${this.connections.size}`);
            console.log(`✅ Successfully reconnected to ${connectedCount} peer(s)`);
        } else {
            // Reset reconnection flag before updating status
            this.isReconnecting = false;
            this.updateConnectionStatus('', 'Ready to connect');
            // Only hide file transfer section if no peers available
            if (this.elements.fileTransferSection) {
                this.elements.fileTransferSection.classList.add('hidden');
                console.log('📁 File transfer section hidden (no peers available)');
            }
            console.log(`ℹ️ Reconnection attempts completed, no peers connected`);
        }
    }
    
    // Create connection promise for a peer
    createConnectionPromise(peerId) {
        return new Promise((resolve) => {
            try {
                console.log(`🔄 Attempting to reconnect to: ${peerId}`);
                const newConnection = this.peer.connect(peerId, {
                    reliable: true
                });
                
                const timeout = setTimeout(() => {
                    console.warn(`⏱️ Reconnection timeout for ${peerId}`);
                    if (this.connections.has(peerId) && this.connections.get(peerId) === newConnection) {
                        this.connections.delete(peerId);
                    }
                    // Mark as tried since reconnection failed
                    this.sessionStateManager.markPeerAsTried(peerId);
                    resolve(false);
                }, this.CONNECTION_TIMEOUT);
                
                newConnection.on('open', () => {
                    clearTimeout(timeout);
                    this.connections.set(peerId, newConnection);
                    this.setupConnectionHandlers(newConnection, timeout);
                    console.log(`✅ Reconnected to: ${peerId}`);
                    // Reset tried flag since connection succeeded
                    this.sessionStateManager.resetPeerTried(peerId);
                    resolve(true);
                });
                
                newConnection.on('error', (error) => {
                    clearTimeout(timeout);
                    console.error(`❌ Reconnection error for ${peerId}:`, error);
                    if (this.connections.has(peerId) && this.connections.get(peerId) === newConnection) {
                        this.connections.delete(peerId);
                    }
                    // Mark as tried since reconnection failed
                    this.sessionStateManager.markPeerAsTried(peerId);
                    resolve(false);
                });
                
                newConnection.on('close', () => {
                    clearTimeout(timeout);
                    if (this.connections.has(peerId) && this.connections.get(peerId) === newConnection) {
                        this.connections.delete(peerId);
                    }
                    // Mark as tried since connection closed
                    this.sessionStateManager.markPeerAsTried(peerId);
                    resolve(false);
                });
                
            } catch (error) {
                console.error(`❌ Error initiating reconnection to ${peerId}:`, error);
                // Mark as tried since reconnection failed
                this.sessionStateManager.markPeerAsTried(peerId);
                resolve(false);
            }
        });
    }
    
    // Check if reconnection is in progress
    isReconnectingInProgress() {
        return this.isReconnecting;
    }
    
    // Reset reconnection state
    resetReconnectionState() {
        this.isReconnecting = false;
    }
    
    // Update peer reference (when peer is reinitialized)
    updatePeerReference(peer) {
        this.peer = peer;
    }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ReconnectionManager;
}

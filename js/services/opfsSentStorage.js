/**
 * OPFS-backed storage for sent files. Streams files to disk instead of holding in memory.
 * Falls back to in-memory Blob storage when OPFS is unavailable (Safari, Firefox).
 */
(function() {
    'use strict';

    const SENT_DIR = 'sent_files';
    const CHUNK_SIZE = 16384; // Match constants

    let _root = null;
    const _blobFallback = new Map(); // fileId -> Blob (when OPFS unavailable)
    const _opfsMap = new Map(); // fileId -> safeFileName (for OPFS lookup)
    const _meta = new Map(); // fileId -> { type } (for OPFS files; size from getFile)

    async function getRoot() {
        if (_root) return _root;
        if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
            _root = await navigator.storage.getDirectory();
            try {
                _root = await _root.getDirectoryHandle(SENT_DIR, { create: true });
            } catch (e) {
                console.warn('[OPFS] Failed to get sent dir:', e);
                _root = null;
            }
        }
        return _root;
    }

    function supportsOPFS() {
        return !!(typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function');
    }

    /**
     * Save file to OPFS (stream, no full-file buffer) or fallback to Blob.
     * @param {File} file - File from input
     * @param {string} fileId - Unique file id
     * @returns {Promise<boolean>} - true if saved (OPFS or fallback)
     */
    async function set(fileId, file) {
        const root = await getRoot();
        if (root) {
            try {
                const unique = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().slice(0, 8) : Date.now().toString(36);
                const safeName = (fileId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'file') + '_' + unique;
                _opfsMap.set(fileId, safeName);
                _meta.set(fileId, { type: file.type || 'application/octet-stream' });
                const handle = await root.getFileHandle(safeName, { create: true });
                const writable = await handle.createWritable();
                await file.stream().pipeTo(writable); // pipeTo closes the writable when done
                return true;
            } catch (e) {
                console.warn('[OPFS] Save failed, falling back to blob:', e);
            }
        }
        const blob = new Blob([await file.arrayBuffer()], { type: file.type });
        _blobFallback.set(fileId, blob);
        _meta.set(fileId, { type: file.type || 'application/octet-stream' });
        return true;
    }

    function has(fileId) {
        if (_blobFallback.has(fileId)) return true;
        return true; // OPFS: we'd need async check; caller uses hasAsync
    }

    async function hasAsync(fileId) {
        if (_blobFallback.has(fileId)) return true;
        const safeName = _opfsMap.get(fileId);
        if (!safeName) return false;
        const root = await getRoot();
        if (!root) return false;
        try {
            await root.getFileHandle(safeName);
            return true;
        } catch (_) {
            _opfsMap.delete(fileId);
            return false;
        }
    }

    function getType(fileId) {
        const m = _meta.get(fileId);
        return m ? m.type : 'application/octet-stream';
    }

    async function getSize(fileId) {
        if (_blobFallback.has(fileId)) return _blobFallback.get(fileId).size;
        const safeName = _opfsMap.get(fileId);
        if (!safeName) return 0;
        const root = await getRoot();
        if (!root) return 0;
        try {
            const handle = await root.getFileHandle(safeName);
            const file = await handle.getFile();
            return file.size;
        } catch (_) {
            return 0;
        }
    }

    /**
     * Get file as Blob for local download (sent file, user clicks download).
     */
    async function getBlob(fileId) {
        if (_blobFallback.has(fileId)) return _blobFallback.get(fileId);
        const safeName = _opfsMap.get(fileId);
        if (!safeName) return null;
        const root = await getRoot();
        if (!root) return null;
        try {
            const handle = await root.getFileHandle(safeName);
            return await handle.getFile();
        } catch (_) {
            return null;
        }
    }

    /**
     * Read a chunk at offset. For streaming to peer.
     * @returns {Promise<ArrayBuffer>}
     */
    async function getChunk(fileId, offset, length) {
        if (_blobFallback.has(fileId)) {
            const blob = _blobFallback.get(fileId);
            const slice = blob.slice(offset, offset + length);
            return await slice.arrayBuffer();
        }
        const safeName = _opfsMap.get(fileId);
        if (!safeName) return null;
        const root = await getRoot();
        if (!root) return null;
        try {
            const handle = await root.getFileHandle(safeName);
            const file = await handle.getFile();
            const slice = file.slice(offset, offset + length);
            return await slice.arrayBuffer();
        } catch (_) {
            return null;
        }
    }

    /**
     * Async generator to read file in chunks. Yields ArrayBuffers.
     */
    async function* readChunks(fileId, chunkSize = CHUNK_SIZE) {
        const size = await getSize(fileId);
        if (size === 0) return;
        let offset = 0;
        while (offset < size) {
            const len = Math.min(chunkSize, size - offset);
            const buf = await getChunk(fileId, offset, len);
            if (!buf) return;
            yield buf;
            offset += len;
        }
    }

    async function deleteFile(fileId) {
        _meta.delete(fileId);
        if (_blobFallback.has(fileId)) {
            _blobFallback.delete(fileId);
            return;
        }
        const safeName = _opfsMap.get(fileId);
        if (!safeName) return;
        _opfsMap.delete(fileId);
        const root = await getRoot();
        if (!root) return;
        try {
            await root.removeEntry(safeName);
        } catch (_) {}
    }

    async function clear() {
        _blobFallback.clear();
        _meta.clear();
        const entries = [..._opfsMap.entries()];
        _opfsMap.clear();
        const root = await getRoot();
        if (root) {
            for (const [, safeName] of entries) {
                try { await root.removeEntry(safeName); } catch (_) {}
            }
        }
    }

    window.OpfsSentStorage = {
        supportsOPFS,
        set,
        has,
        hasAsync,
        getSize,
        getType,
        getBlob,
        getChunk,
        readChunks,
        delete: deleteFile,
        clear
    };
})();

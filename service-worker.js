const CACHE_NAME = 'one-host-cache-v1';
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './assets/logo.svg',
  './assets/tablogo.png',
  './assets/favicon/favicon-32x32.png',
  './assets/favicon/favicon-16x16.png',
  './assets/favicon/apple-touch-icon.png'
];

// ✅ STREAMING DOWNLOAD SYSTEM
// Active download streams registry
const activeStreams = new Map();
const streamControllers = new Map();

// Install event: cache essential files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

// Activate event: cleanup old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
});

// ✅ MAIN FETCH HANDLER - Stream Downloads + Cache
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  // Handle streaming downloads
  if (url.pathname.startsWith('/download/')) {
    event.respondWith(handleStreamDownload(event.request));
    return;
  }
  
  // Regular cache-first strategy for other requests
  event.respondWith(
    caches.match(event.request).then(response => response || fetch(event.request))
  );
});

// ✅ STREAMING DOWNLOAD HANDLER
async function handleStreamDownload(request) {
  const url = new URL(request.url);
  const fileId = url.pathname.split('/download/')[1];
  
  console.log(`🌊 Service Worker: Handling stream download for fileId: ${fileId}`);
  
  // Get stream info from active streams
  const streamInfo = activeStreams.get(fileId);
  if (!streamInfo) {
    console.error(`❌ Stream info not found for fileId: ${fileId}`);
    return new Response('Stream not found', { status: 404 });
  }
  
  // Create readable stream for the download
  const stream = new ReadableStream({
    start(controller) {
      console.log(`🚀 Stream started for: ${streamInfo.filename}`);
      
      // Register stream controller for chunk data
      streamControllers.set(fileId, controller);
      
      // Notify main thread that stream is ready
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'stream-ready',
            fileId: fileId
          });
        });
      });
    },
    
    cancel(reason) {
      console.log(`❌ Stream cancelled for fileId: ${fileId}`, reason);
      cleanupStream(fileId);
    }
  });
  
  // Return response with proper download headers
  return new Response(stream, {
    headers: {
      'Content-Type': streamInfo.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${streamInfo.filename}"`,
      'Content-Length': streamInfo.size?.toString() || '',
      'Cache-Control': 'no-cache'
    }
  });
}

// ✅ MESSAGE HANDLER - Communication with main thread
self.addEventListener('message', event => {
  const { type, data } = event.data;
  
  switch (type) {
    case 'register-stream':
      registerStream(data);
      break;
      
    case 'stream-chunk':
      pipeChunkToStream(data);
      break;
      
    case 'complete-stream':
      completeStream(data.fileId);
      break;
      
    case 'cancel-stream':
      cancelStream(data.fileId);
      break;
      
    default:
      console.warn(`Unknown message type: ${type}`);
  }
});

// ✅ STREAM MANAGEMENT FUNCTIONS

function registerStream(streamInfo) {
  const { fileId, filename, mimeType, size } = streamInfo;
  
  activeStreams.set(fileId, {
    filename,
    mimeType,
    size,
    startTime: Date.now(),
    bytesReceived: 0
  });
  
  console.log(`📝 Registered stream for: ${filename} (${fileId})`);
}

function pipeChunkToStream(chunkData) {
  const { fileId, data, chunkIndex } = chunkData;
  const controller = streamControllers.get(fileId);
  const streamInfo = activeStreams.get(fileId);
  
  if (controller && streamInfo) {
    try {
      // Convert ArrayBuffer to Uint8Array and enqueue
      const uint8Array = new Uint8Array(data);
      controller.enqueue(uint8Array);
      
      // Update stream info
      streamInfo.bytesReceived += uint8Array.length;
      streamInfo.lastChunkTime = Date.now();
      
      console.log(`📦 Chunk ${chunkIndex} piped for fileId: ${fileId} (${uint8Array.length} bytes)`);
    } catch (error) {
      console.error(`❌ Error piping chunk for fileId: ${fileId}`, error);
    }
  } else {
    console.warn(`⚠️ Controller or stream info not found for fileId: ${fileId}`);
  }
}

function completeStream(fileId) {
  const controller = streamControllers.get(fileId);
  const streamInfo = activeStreams.get(fileId);
  
  if (controller) {
    try {
      controller.close();
      console.log(`✅ Stream completed for fileId: ${fileId}`);
      
      if (streamInfo) {
        const duration = Date.now() - streamInfo.startTime;
        const speed = streamInfo.bytesReceived / (duration / 1000);
        console.log(`📊 Transfer stats: ${streamInfo.bytesReceived} bytes in ${duration}ms (${(speed / 1024 / 1024).toFixed(2)} MB/s)`);
      }
    } catch (error) {
      console.error(`❌ Error completing stream for fileId: ${fileId}`, error);
    }
  }
  
  cleanupStream(fileId);
}

function cancelStream(fileId) {
  const controller = streamControllers.get(fileId);
  
  if (controller) {
    try {
      controller.error(new Error('Stream cancelled by user'));
      console.log(`❌ Stream cancelled for fileId: ${fileId}`);
    } catch (error) {
      console.error(`❌ Error cancelling stream for fileId: ${fileId}`, error);
    }
  }
  
  cleanupStream(fileId);
}

function cleanupStream(fileId) {
  streamControllers.delete(fileId);
  activeStreams.delete(fileId);
  console.log(`🧹 Cleaned up stream for fileId: ${fileId}`);
}

console.log('🌊 One-Host Streaming Service Worker loaded');
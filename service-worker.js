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
let keepAliveInterval = null;

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
    const fileId = url.pathname.split('/download/')[1];
    console.log(`🌊 Service Worker: Intercepted download request for: ${url.pathname}`);
    console.log(`📋 FileId extracted: ${fileId}`);
    console.log(`⏰ Download request timestamp: ${new Date().toISOString()}`);
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
  
  // Use the pre-created stream (controller already exists!)
  const stream = streamInfo.stream;
  if (!stream) {
    console.error(`❌ No pre-created stream found for fileId: ${fileId}`);
    return new Response('Stream not found', { status: 404 });
  }
  
  console.log(`🎯 Using pre-created stream for: ${streamInfo.filename} (${fileId})`);
  console.log(`📊 Active streams: ${activeStreams.size}, Controllers: ${streamControllers.size}`);
  
  // Debug: Check if controller exists for this fileId
  const controller = streamControllers.get(fileId);
  if (controller) {
    console.log(`✅ Stream controller found for download: ${fileId}`);
  } else {
    console.error(`❌ No stream controller found for download: ${fileId}`);
    console.log(`🔍 Available controllers:`, Array.from(streamControllers.keys()));
  }
  
  // Return response with proper download headers for browser download manager
  const headers = new Headers({
    'Content-Type': streamInfo.mimeType || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${streamInfo.filename}"`,
    'Content-Length': streamInfo.size?.toString() || '',
    'Accept-Ranges': 'bytes',

    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    // Additional headers for better browser download recognition
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'",
    'X-Frame-Options': 'DENY'
  });

  console.log(`📤 Returning download response for: ${streamInfo.filename} (${streamInfo.size} bytes)`);
  
  return new Response(stream, {
    status: 200,
    statusText: 'OK',
    headers: headers
  });
}

// ✅ MESSAGE HANDLER - Communication with main thread
self.addEventListener('message', event => {
  const { type, data } = event.data;
  
  switch (type) {
    case 'register-stream':
      registerStream(data);
      startKeepAlive();
      break;
      
    case 'stream-chunk':
      pipeChunkToStream(data);
      break;
      
    case 'complete-stream':
      completeStream(data.fileId);
      stopKeepAliveIfNoActiveStreams();
      break;
      
    case 'cancel-stream':
      cancelStream(data.fileId);
      stopKeepAliveIfNoActiveStreams();
      break;
      
    case 'start-background-fetch':
      startBackgroundFetch(data);
      break;
      
    case 'keep-alive':
      // Respond to keep-alive ping from main thread
      break;
      
    default:
      console.warn(`Unknown message type: ${type}`);
  }
});

// ✅ STREAM MANAGEMENT FUNCTIONS

function registerStream(streamInfo) {
  const { fileId, filename, mimeType, size } = streamInfo;
  
  // Store stream info
  activeStreams.set(fileId, {
    filename,
    mimeType,
    size,
    startTime: Date.now(),
    bytesReceived: 0
  });
  
  // PRE-CREATE THE STREAM CONTROLLER - This is the critical fix!
  const stream = new ReadableStream({
    start(controller) {
      // Store controller immediately when stream is created
      streamControllers.set(fileId, controller);
      console.log(`🎯 Stream controller created for: ${fileId}`);
      
      // CRITICAL: Send a small initial chunk immediately to trigger browser download
      // This ensures the browser recognizes this as a valid download response
      const initialChunk = new Uint8Array(0); // Empty chunk to start the stream
      try {
        controller.enqueue(initialChunk);
        console.log(`🏁 Initial chunk enqueued to start download for: ${fileId}`);
      } catch (error) {
        console.error(`❌ Error enqueuing initial chunk:`, error);
      }
      
      // Send stream-ready message to main thread
      self.clients.matchAll().then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'stream-ready',
            fileId: fileId,
            filename: filename
          });
        });
      });
    },
    cancel(reason) {
      console.log(`❌ Stream cancelled for fileId: ${fileId}`, reason);
      cleanupStream(fileId);
    }
  });
  
  // Store the pre-created stream for the fetch handler
  activeStreams.get(fileId).stream = stream;
  
  console.log(`📝 Registered stream with pre-created controller: ${filename} (${fileId})`);
  
  // Send confirmation back to main thread
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'stream-registered',
        fileId: fileId,
        filename: filename
      });
    });
  });
}

function pipeChunkToStream(chunkData) {
  const { fileId, data, chunkIndex } = chunkData;
  const controller = streamControllers.get(fileId);
  const streamInfo = activeStreams.get(fileId);
  
  console.log(`🔄 Attempting to pipe chunk ${chunkIndex} for fileId: ${fileId}`);
  console.log(`🔍 Controller exists: ${!!controller}, StreamInfo exists: ${!!streamInfo}`);
  
  if (controller && streamInfo) {
    try {
      // Convert ArrayBuffer to Uint8Array and enqueue
      const uint8Array = new Uint8Array(data);
      console.log(`📤 Enqueueing chunk ${chunkIndex}: ${uint8Array.length} bytes`);
      
      controller.enqueue(uint8Array);
      console.log(`✅ Chunk ${chunkIndex} successfully enqueued`);
      
      // Update stream info
      streamInfo.bytesReceived += uint8Array.length;
      streamInfo.lastChunkTime = Date.now();
      
      console.log(`📊 Progress: ${streamInfo.bytesReceived}/${streamInfo.size} bytes (${((streamInfo.bytesReceived / streamInfo.size) * 100).toFixed(1)}%)`);
      
      // Check if we've received all bytes
      if (streamInfo.size && streamInfo.bytesReceived >= streamInfo.size) {
        console.log(`🎯 All bytes received for ${fileId}, auto-completing stream`);
        // Auto-complete the stream when all bytes are received
        setTimeout(() => completeStream(fileId), 100); // Small delay to ensure last chunk is processed
      }
    } catch (error) {
      console.error(`❌ Error piping chunk ${chunkIndex} for fileId: ${fileId}`, error);
      console.error(`❌ Error details:`, error.stack);
    }
  } else {
    console.error(`❌ Cannot pipe chunk ${chunkIndex} for fileId: ${fileId}`);
    console.log(`🔍 Available controllers:`, Array.from(streamControllers.keys()));
    console.log(`🔍 Available streams:`, Array.from(activeStreams.keys()));
    if (!controller) console.error(`❌ Missing controller for: ${fileId}`);
    if (!streamInfo) console.error(`❌ Missing stream info for: ${fileId}`);
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
  
  // Clean up stream reference
  const streamInfo = activeStreams.get(fileId);
  if (streamInfo && streamInfo.stream) {
    delete streamInfo.stream;
  }
  
  activeStreams.delete(fileId);
  console.log(`🧹 Cleaned up stream for fileId: ${fileId}`);
}

// ✅ KEEP-ALIVE MECHANISM TO PREVENT SERVICE WORKER TERMINATION
function startKeepAlive() {
  if (keepAliveInterval) return; // Already running
  
  keepAliveInterval = setInterval(() => {
    // Send heartbeat to all clients to keep Service Worker alive
    self.clients.matchAll().then(clients => {
      clients.forEach(client => {
        client.postMessage({ type: 'service-worker-heartbeat' });
      });
    });
  }, 10000); // Every 10 seconds
  
  console.log('🔄 Keep-alive started for Service Worker');
}

function stopKeepAliveIfNoActiveStreams() {
  if (activeStreams.size === 0 && keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
    console.log('⏹️ Keep-alive stopped - no active streams');
  }
}

// ✅ BACKGROUND FETCH API - Android Studio-like Downloads
async function startBackgroundFetch(data) {
  const { fileId, filename, mimeType, size } = data;
  
  console.log(`🚀 Starting Background Fetch for: ${filename} (${size} bytes)`);
  
  try {
    // Start background fetch with native Chrome download manager
    const bgFetch = await self.registration.backgroundFetch.fetch(fileId, `/download/${fileId}`, {
      title: `Downloading ${filename}`,
      icons: [
        {
          src: '/assets/tablogo.png',
          sizes: '64x64',
          type: 'image/png'
        }
      ],
      downloadTotal: size,
      // This creates the Android Studio-like download behavior!
    });
    
    console.log(`✅ Background Fetch started for: ${filename}`);
    
    // Notify main thread
    self.clients.matchAll().then(clients => {
      clients.forEach(client => {
        client.postMessage({
          type: 'background-fetch-started',
          fileId: fileId,
          filename: filename
        });
      });
    });
    
  } catch (error) {
    console.error(`❌ Background Fetch failed for ${filename}:`, error);
    
    // Fallback to regular stream download
    console.log(`📋 Falling back to regular stream download for: ${filename}`);
    self.clients.matchAll().then(clients => {
      clients.forEach(client => {
        client.postMessage({
          type: 'background-fetch-fallback',
          fileId: fileId,
          filename: filename
        });
      });
    });
  }
}

// ✅ BACKGROUND FETCH EVENT HANDLERS
self.addEventListener('backgroundfetchsuccess', event => {
  console.log(`✅ Background Fetch completed successfully:`, event.registration.id);
  
  // Notify main thread of completion
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'background-fetch-success',
        fileId: event.registration.id
      });
    });
  });
});

self.addEventListener('backgroundfetchfail', event => {
  console.log(`❌ Background Fetch failed:`, event.registration.id);
  
  // Notify main thread of failure
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'background-fetch-fail',
        fileId: event.registration.id
      });
    });
  });
});

self.addEventListener('backgroundfetchabort', event => {
  console.log(`⏹️ Background Fetch aborted:`, event.registration.id);
  
  // Notify main thread of abort
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: 'background-fetch-abort',
        fileId: event.registration.id
      });
    });
  });
});

self.addEventListener('backgroundfetchclick', event => {
  console.log(`👆 Background Fetch clicked:`, event.registration.id);
  
  // Open the app when user clicks on the download notification
  self.clients.openWindow('/');
});

console.log('🌊 One-Host Streaming Service Worker loaded');
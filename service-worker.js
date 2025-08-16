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
const completedFiles = new Map(); // Store completed file data for downloads
let keepAliveInterval = null;

// Install event: cache essential files and skip waiting
self.addEventListener('install', event => {
  console.log('🔧 Service Worker installing...');
  // Skip waiting to activate immediately
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

// Activate event: cleanup old caches and claim clients
self.addEventListener('activate', event => {
  console.log('🚀 Service Worker activating...');
  
  event.waitUntil(
    Promise.all([
      // Claim all clients immediately
      self.clients.claim(),
      // Clean up old caches
      caches.keys().then(keys =>
        Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
      )
    ]).then(() => {
      console.log('✅ Service Worker activated and claimed all clients');
    })
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
  
  console.log(`🌊 Service Worker: Handling download request for fileId: ${fileId}`);
  
  // Check if we have the complete file ready
  const completedFile = completedFiles.get(fileId);
  if (completedFile) {
    console.log(`✅ Serving complete file: ${completedFile.filename} (${completedFile.data.length} bytes)`);
    
    // Return the complete file as response
    const headers = new Headers({
      'Content-Type': completedFile.mimeType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${completedFile.filename}"`,
      'Content-Length': completedFile.size.toString(),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Content-Type-Options': 'nosniff'
    });

    console.log(`📤 Serving complete file download: ${completedFile.filename}`);
    
    return new Response(completedFile.data, {
      status: 200,
      statusText: 'OK',
      headers: headers
    });
  }
  
  // Check if stream is still in progress
  const streamInfo = activeStreams.get(fileId);
  if (streamInfo && !streamInfo.isComplete) {
    console.log(`⏳ File still being received: ${streamInfo.filename} (${streamInfo.bytesReceived}/${streamInfo.size} bytes)`);
    return new Response('File still being transferred, please wait', { 
      status: 202, // Accepted but not ready
      statusText: 'File Transfer In Progress'
    });
  }
  
  // File not found
  console.error(`❌ File not found for fileId: ${fileId}`);
  console.log(`🔍 Available completed files:`, Array.from(completedFiles.keys()));
  console.log(`🔍 Available active streams:`, Array.from(activeStreams.keys()));
  
  return new Response('File not found or expired', { 
    status: 404,
    statusText: 'File Not Found'
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
  
  // Store stream info and initialize chunk storage
  activeStreams.set(fileId, {
    filename,
    mimeType,
    size,
    startTime: Date.now(),
    bytesReceived: 0,
    chunks: [], // Store chunks as they arrive
    isComplete: false
  });
  
  console.log(`📝 Registered stream for: ${filename} (${fileId}) - Size: ${size} bytes`);
  
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
  const streamInfo = activeStreams.get(fileId);
  
  console.log(`🔄 Storing chunk ${chunkIndex} for fileId: ${fileId}`);
  
  if (streamInfo) {
    try {
      // Convert ArrayBuffer to Uint8Array and store it
      const uint8Array = new Uint8Array(data);
      console.log(`📦 Storing chunk ${chunkIndex}: ${uint8Array.length} bytes`);
      
      // Store chunk in order
      streamInfo.chunks[chunkIndex] = uint8Array;
      streamInfo.bytesReceived += uint8Array.length;
      streamInfo.lastChunkTime = Date.now();
      
      console.log(`📊 Progress: ${streamInfo.bytesReceived}/${streamInfo.size} bytes (${((streamInfo.bytesReceived / streamInfo.size) * 100).toFixed(1)}%)`);
      
      // Check if we've received all bytes
      if (streamInfo.size && streamInfo.bytesReceived >= streamInfo.size) {
        console.log(`🎯 All bytes received for ${fileId}, marking as complete`);
        streamInfo.isComplete = true;
        
        // Combine all chunks into complete file
        const completeFile = combineChunks(streamInfo.chunks);
        completedFiles.set(fileId, {
          data: completeFile,
          filename: streamInfo.filename,
          mimeType: streamInfo.mimeType,
          size: streamInfo.size
        });
        
        console.log(`✅ Complete file ready for download: ${streamInfo.filename} (${completeFile.length} bytes)`);
        
        // Auto-complete the stream
        setTimeout(() => completeStream(fileId), 100);
      }
    } catch (error) {
      console.error(`❌ Error storing chunk ${chunkIndex} for fileId: ${fileId}`, error);
      console.error(`❌ Error details:`, error.stack);
    }
  } else {
    console.error(`❌ No stream info found for fileId: ${fileId}`);
    console.log(`🔍 Available streams:`, Array.from(activeStreams.keys()));
  }
}

// Helper function to combine chunks into complete file
function combineChunks(chunks) {
  // Calculate total size
  let totalSize = 0;
  for (const chunk of chunks) {
    if (chunk) totalSize += chunk.length;
  }
  
  // Create combined array
  const combined = new Uint8Array(totalSize);
  let offset = 0;
  
  for (const chunk of chunks) {
    if (chunk) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
  }
  
  return combined;
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
  activeStreams.delete(fileId);
  completedFiles.delete(fileId);
  streamControllers.delete(fileId); // Clean up any old references
  console.log(`🧹 Cleaned up stream and completed file for fileId: ${fileId}`);
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
const CACHE_NAME = 'one-host-cache-v2';
const STATIC_CACHE = 'one-host-static-v2';
const DYNAMIC_CACHE = 'one-host-dynamic-v2';
const FILE_CACHE = 'one-host-files-v2';

const STATIC_URLS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  './assets/logo.svg',
  './assets/logo_pwa.svg',
  './assets/tablogo.png',
  './assets/favicon/favicon-32x32.png',
  './assets/favicon/favicon-16x16.png',
  './assets/favicon/apple-touch-icon.png',
  './assets/pwa-icons/icon-72x72.png',
  './assets/pwa-icons/icon-96x96.png',
  './assets/pwa-icons/icon-128x128.png',
  './assets/pwa-icons/icon-144x144.png',
  './assets/pwa-icons/icon-152x152.png',
  './assets/pwa-icons/icon-192x192.png',
  './assets/pwa-icons/icon-384x384.png',
  './assets/pwa-icons/icon-512x512.png',
  './assets/pwa-icons/icon-1024x1024.png'
];

// Install event: cache essential files
self.addEventListener('install', event => {
  console.log('Service Worker: Installing...');
  event.waitUntil(
    Promise.all([
      caches.open(STATIC_CACHE).then(cache => {
        console.log('Service Worker: Caching static files');
        return cache.addAll(STATIC_URLS);
      }),
      caches.open(FILE_CACHE).then(cache => {
        console.log('Service Worker: File cache ready');
        return cache;
      })
    ])
  );
  self.skipWaiting();
});

// Activate event: cleanup old caches
self.addEventListener('activate', event => {
  console.log('Service Worker: Activating...');
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => 
          key !== STATIC_CACHE && 
          key !== DYNAMIC_CACHE && 
          key !== FILE_CACHE
        ).map(key => {
          console.log('Service Worker: Deleting old cache', key);
          return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch event: serve from cache, fallback to network
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Handle file downloads and large file transfers
  if (request.method === 'GET' && url.pathname.includes('file')) {
    event.respondWith(handleFileRequest(request));
    return;
  }

  // Handle static assets
  if (STATIC_URLS.includes(url.pathname) || STATIC_URLS.includes(url.pathname.slice(1))) {
    event.respondWith(handleStaticRequest(request));
    return;
  }

  // Handle API requests and dynamic content
  if (url.pathname.startsWith('/api/') || url.pathname.includes('peerjs')) {
    event.respondWith(handleDynamicRequest(request));
    return;
  }

  // Default: network first, cache fallback
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(DYNAMIC_CACHE).then(cache => {
            cache.put(request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        return caches.match(request);
      })
  );
});

// Handle static file requests
async function handleStaticRequest(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }
  
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    console.log('Service Worker: Static file fetch failed', error);
    return new Response('Offline - Static file not available', { status: 503 });
  }
}

// Handle dynamic requests (API, WebRTC)
async function handleDynamicRequest(request) {
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      const responseClone = response.clone();
      caches.open(DYNAMIC_CACHE).then(cache => {
        cache.put(request, responseClone);
      });
    }
    return response;
  } catch (error) {
    console.log('Service Worker: Dynamic request failed', error);
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }
    return new Response('Offline - Network request failed', { status: 503 });
  }
}

// Handle file requests with large file support
async function handleFileRequest(request) {
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      // For large files, we don't cache them in the service worker
      // They are handled by the main app's IndexedDB storage
      return response;
    }
    return response;
  } catch (error) {
    console.log('Service Worker: File request failed', error);
    return new Response('File not available offline', { status: 503 });
  }
}

// Background sync for file transfers
self.addEventListener('sync', event => {
  console.log('Service Worker: Background sync triggered', event.tag);
  
  if (event.tag === 'file-transfer-sync') {
    event.waitUntil(handleFileTransferSync());
  }
});

// Handle background file transfer sync
async function handleFileTransferSync() {
  try {
    // This will be implemented in the main app
    // The service worker can trigger background sync for interrupted transfers
    console.log('Service Worker: Processing background file transfer sync');
    
    // Notify all clients about the sync
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({
        type: 'background-sync',
        action: 'file-transfer-sync'
      });
    });
  } catch (error) {
    console.error('Service Worker: Background sync failed', error);
  }
}

// Handle push notifications (for future use)
self.addEventListener('push', event => {
  console.log('Service Worker: Push notification received');
  
  const options = {
    body: event.data ? event.data.text() : 'New file transfer available',
    icon: './assets/pwa-icons/icon-192x192.png',
    badge: './assets/pwa-icons/icon-72x72.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      {
        action: 'open',
        title: 'Open App',
        icon: './assets/pwa-icons/icon-96x96.png'
      },
      {
        action: 'close',
        title: 'Close',
        icon: './assets/pwa-icons/icon-96x96.png'
      }
    ]
  };

  event.waitUntil(
    self.registration.showNotification('One-Host File Transfer', options)
  );
});

// Handle notification clicks
self.addEventListener('notificationclick', event => {
  console.log('Service Worker: Notification clicked', event.action);
  
  event.notification.close();

  if (event.action === 'open') {
    event.waitUntil(
      self.clients.matchAll().then(clients => {
        if (clients.length > 0) {
          clients[0].focus();
        } else {
          self.clients.openWindow('./');
        }
      })
    );
  }
});

// Handle messages from main app
self.addEventListener('message', event => {
  console.log('Service Worker: Message received', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CACHE_FILES') {
    event.waitUntil(cacheFiles(event.data.files));
  }
});

// Cache files for offline use
async function cacheFiles(files) {
  const cache = await caches.open(FILE_CACHE);
  for (const file of files) {
    try {
      await cache.add(file);
      console.log('Service Worker: Cached file', file);
    } catch (error) {
      console.error('Service Worker: Failed to cache file', file, error);
    }
  }
} 
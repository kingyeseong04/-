// sw.js — notifications only.
//
// Mobile browsers (Android Chrome) refuse `new Notification(...)` from a page
// and require a service worker's showNotification() instead, so angle.html
// registers this. It deliberately has NO fetch handler: nothing on the site is
// cached or intercepted, so the other pages load exactly as before.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.indexOf('angle.html') >= 0 && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('angle.html');
  }));
});

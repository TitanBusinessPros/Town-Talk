// firebase-messaging-sw.js
//
// IMPORTANT: this file must be uploaded to your site's ROOT directory
// (same place as index.html — e.g. https://yoursite.com/firebase-messaging-sw.js),
// NOT inside a subfolder. Service workers only control pages at or below
// the folder they're served from, so root is required for this to work
// across every page of the site.
//
// This only handles notifications that arrive while nobody has the site
// open (background/closed tab). Notifications that arrive while someone
// IS looking at Town Fuss are handled separately, inside index.html
// itself (see initMessaging/onMessage), so they show as a small in-page
// toast instead of a duplicate OS popup.

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

// Same public config object used in index.html — safe to expose, same as
// there. Keep this in sync if you ever rotate the Firebase project.
firebase.initializeApp({
  apiKey: "AIzaSyC0EfVQypjbEHRswbO-Np4lCQjFhmwEqrA",
  authDomain: "town-talk-87ff7.firebaseapp.com",
  projectId: "town-talk-87ff7",
  storageBucket: "town-talk-87ff7.firebasestorage.app",
  messagingSenderId: "95719537435",
  appId: "1:95719537435:web:b496db2c2144adb3c831be",
});

const messaging = firebase.messaging();

// Explicit background handler — needed for two things a plain
// notification-payload message can't do on its own: setting the home-
// screen icon's badge number (Badging API, navigator.setAppBadge/
// clearAppBadge — added 2026-08-16 so the badge reflects a real unread
// count instead of relying on however the OS happens to track the
// notification shade, which wasn't clearing reliably), and reading the
// badgeCount index.js now includes in the data payload (see
// sendPushToUser). Defining this handler takes over notification display
// from Firebase's own default behavior, so this also does what that
// default would have done — show the actual system notification —
// itself.
messaging.onBackgroundMessage((payload) => {
  const badgeCount = payload.data?.badgeCount;
  if (badgeCount !== undefined && self.navigator?.setAppBadge) {
    const n = parseInt(badgeCount, 10);
    (n > 0 ? self.navigator.setAppBadge(n) : self.navigator.clearAppBadge()).catch(() => {});
  }
  const { title, body } = payload.notification || {};
  if (!title) return; // data-only message, nothing to show
  self.registration.showNotification(title, {
    body,
    icon: "/icons/icon-192.png",
    data: payload.data,
  });
});

// Clicking the notification focuses an existing Town Fuss tab if one is
// open, or opens a new one otherwise, instead of always spawning a new tab.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.click_action || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

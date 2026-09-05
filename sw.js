/* Service worker: required for push notifications to work at all. */

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/* A push arrives from the server. Show it. */
self.addEventListener("push", (event) => {
  let payload = { title: "Kinesis", body: "Έχεις νέα ενημέρωση." };
  try {
    if (event.data) payload = Object.assign(payload, event.data.json());
  } catch (e) {
    if (event.data) payload.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || "Kinesis", {
      body: payload.body || "",
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: payload.tag || "kinesis",
      data: { url: payload.url || "./index.html" },
    })
  );
});

/* Tapping the notification opens the app (or focuses it if already open). */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./index.html";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

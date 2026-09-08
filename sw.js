/* Service worker
   Δύο δουλειές:
   1) Οι push ειδοποιήσεις. Χωρίς αυτό το αρχείο δεν δουλεύουν καθόλου.
   2) Offline. Χωρίς σήμα η εφαρμογή ανοίγει και δείχνει ό,τι ξέρει,
      αντί για λευκή σελίδα.

   Σε κάθε ανέβασμα νέας έκδοσης άλλαξε το VERSION πιο κάτω. Έτσι
   σβήνει η παλιά μνήμη και οι πελάτες παίρνουν τα καινούρια αρχεία.
*/

const VERSION = "kinesis-v3";
const SHELL = VERSION + "-shell";
const RUNTIME = VERSION + "-runtime";

/* Τα δικά μας αρχεία. Μπαίνουν ένα-ένα: αν κάποιο λείπει ή έχει
   λάθος όνομα, δεν ρίχνει όλη την εγκατάσταση μαζί του. */
const SHELL_FILES = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

/* Βιβλιοθήκες και γραμματοσειρές από τρίτους. Οι διευθύνσεις έχουν
   μέσα τον αριθμό έκδοσης, οπότε είναι ασφαλές να κρατηθούν για
   πάντα — δεν αλλάζει ποτέ το περιεχόμενό τους. */
const CDN_HOSTS = [
  "unpkg.com",
  "cdn.tailwindcss.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) =>
      Promise.all(SHELL_FILES.map((f) => cache.add(f).catch(() => { /* αγνόησε */ })))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== SHELL && n !== RUNTIME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

/* ------------------------------------------------------------------
   Offline
   ------------------------------------------------------------------ */

const isCdn = (url) => CDN_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h));

/* Πρώτα το δίκτυο, η μνήμη ως δίχτυ ασφαλείας. Για τη σελίδα, ώστε
   μια νέα έκδοση να φαίνεται αμέσως και να μη μένει κανείς
   κολλημένος σε παλιό κώδικα. */
async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    const cache = await caches.open(SHELL);
    cache.put(request, fresh.clone());
    return fresh;
  } catch (e) {
    const hit = await caches.match(request);
    if (hit) return hit;
    const shell = await caches.match("./index.html");
    if (shell) return shell;
    throw e;
  }
}

/* Πρώτα η μνήμη, με ανανέωση στο παρασκήνιο. Για εικονίδια,
   βιβλιοθήκες και γραμματοσειρές. */
async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) {
    fetch(request)
      .then((res) => caches.open(RUNTIME).then((c) => c.put(request, res)))
      .catch(() => { /* αγνόησε */ });
    return hit;
  }
  const res = await fetch(request);
  const cache = await caches.open(RUNTIME);
  cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;

  /* Οι κλήσεις στη βάση είναι POST και πρέπει να φτάνουν πάντα
     ζωντανές. Δεν τις αγγίζουμε. */
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.hostname.endsWith("supabase.co")) return;

  const sameOrigin = url.origin === self.location.origin;

  if (req.mode === "navigate" || (sameOrigin && url.pathname.endsWith(".html"))) {
    event.respondWith(networkFirst(req));
    return;
  }

  if (sameOrigin || isCdn(url)) {
    event.respondWith(cacheFirst(req).catch(() => caches.match(req)));
  }
});

/* ------------------------------------------------------------------
   Ειδοποιήσεις
   ------------------------------------------------------------------ */

/* Το όνομα του γυμναστηρίου. Ο service worker δεν βλέπει τις ρυθμίσεις,
   οπότε του το στέλνει η σελίδα σε κάθε άνοιγμα (tellServiceWorker).
   Ο browser τον σβήνει και τον ξαναξυπνάει όποτε θέλει, άρα μια απλή
   μεταβλητή δεν κρατάει — το γράφουμε στη μνήμη του browser. */
const BRAND_URL = "./__brand";
const BRAND_FALLBACK = "Γυμναστήριο";
let brandMemo = null;

async function readBrand() {
  if (brandMemo) return brandMemo;
  try {
    const cache = await caches.open(RUNTIME);
    const res = await cache.match(BRAND_URL);
    if (res) {
      const name = (await res.text()).trim();
      if (name) brandMemo = name;
    }
  } catch (e) { /* αγνόησε */ }
  return brandMemo || BRAND_FALLBACK;
}

async function writeBrand(name) {
  if (!name || typeof name !== "string") return;
  brandMemo = name.trim();
  try {
    const cache = await caches.open(RUNTIME);
    await cache.put(BRAND_URL, new Response(brandMemo, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }));
  } catch (e) { /* αγνόησε */ }
}

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg && msg.type === "brand") event.waitUntil(writeBrand(msg.name));
});

/* Έρχεται push από τον διακομιστή. Δείξ' το. */
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const brand = await readBrand();
    let payload = { body: "Έχεις νέα ενημέρωση." };
    try {
      if (event.data) payload = Object.assign(payload, event.data.json());
    } catch (e) {
      if (event.data) payload.body = event.data.text();
    }

    await self.registration.showNotification(payload.title || brand, {
      body: payload.body || "",
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      tag: payload.tag || "kinesis",
      data: { url: payload.url || "./index.html" },
    });
  })());
});

/* Πάτημα στην ειδοποίηση: ανοίγει η εφαρμογή, ή έρχεται μπροστά αν
   είναι ήδη ανοιχτή. */
/* Το ίδιο αρχείο εξυπηρετεί και την εφαρμογή πελατών και τη
   διαχείριση. Παλιά φέρναμε μπροστά όποιο παράθυρο βρίσκαμε πρώτο,
   οπότε η ειδοποίηση της διαχείρισης άνοιγε τη σελίδα πελάτη. Τώρα
   ψάχνουμε παράθυρο της σωστής σελίδας. */
const samePage = (a, b) => {
  const tidy = (p) => p.replace(/\/(index\.html)?$/, "/");
  return tidy(a) === tidy(b);
};

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./index.html";
  const url = new URL(target, self.location.href);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        try {
          if (samePage(new URL(client.url).pathname, url.pathname) && "focus" in client) {
            return client.focus();
          }
        } catch (e) { /* αγνόησε */ }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url.href);
      /* Χωρίς openWindow, καλύτερα κάτι παρά τίποτα. */
      for (const client of list) if ("focus" in client) return client.focus();
    })
  );
});

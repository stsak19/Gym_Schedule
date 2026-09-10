/* Service worker
   Δύο δουλειές:
   1) Οι push ειδοποιήσεις. Χωρίς αυτό το αρχείο δεν δουλεύουν καθόλου.
   2) Offline. Χωρίς σήμα η εφαρμογή ανοίγει και δείχνει ό,τι ξέρει,
      αντί για λευκή σελίδα.

   Σε κάθε ανέβασμα νέας έκδοσης άλλαξε το VERSION πιο κάτω. Έτσι
   σβήνει η παλιά μνήμη και οι πελάτες παίρνουν τα καινούρια αρχεία.
*/

const VERSION = "app-v7";
const SHELL = VERSION + "-shell";
const RUNTIME = VERSION + "-runtime";

/* Η επωνυμία δεν δένεται με την έκδοση: αν την κρατούσαμε στο RUNTIME
   θα σβηνόταν σε κάθε ανέβασμα και το εικονίδιο στην αρχική οθόνη θα
   ξαναγύριζε για λίγο στο εφεδρικό όνομα. */
const BRAND_CACHE = "brand-store";

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
        names
          .filter((n) => n !== SHELL && n !== RUNTIME && n !== BRAND_CACHE)
          .map((n) => caches.delete(n))
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

/* Το manifest.json είναι στατικό αρχείο, αλλά το όνομα που δείχνει το
   κινητό κάτω από το εικονίδιο στην αρχική οθόνη το ορίζει ο
   διαχειριστής. Οπότε το πιάνουμε στον αέρα και του αλλάζουμε το όνομα
   πριν φτάσει στον browser. Έτσι το αρχείο μένει κανονικό
   manifest.json — με blob ή data URL κάποιοι browsers αρνούνται να
   προχωρήσουν στην εγκατάσταση. */
async function brandedManifest(request) {
  let res = null;
  try {
    res = await fetch(request);
    const copy = res.clone();
    caches.open(SHELL).then((c) => c.put(request, copy)).catch(() => { /* αγνόησε */ });
  } catch (e) {
    res = await caches.match(request);
  }
  if (!res) throw new Error("no manifest");

  try {
    const m = await res.clone().json();
    const brand = await readBrand();
    m.name = brand;
    m.short_name = brand;

    /* Μόνο κανονική διεύθυνση. Λογότυπο σε data URL το κόβουν τα
       περισσότερα κινητά και χαλάει όλη η εγκατάσταση. */
    const logo = await readLogo();
    if (logo && /^https?:/i.test(logo)) {
      m.icons = [{ src: logo, sizes: "512x512", type: "image/png" }].concat(m.icons || []);
    }

    return new Response(JSON.stringify(m), {
      headers: {
        "content-type": "application/manifest+json; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  } catch (e) {
    /* Χαλασμένο JSON: κάλλιο το αρχικό παρά τίποτα. */
    return res;
  }
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

  if (sameOrigin && url.pathname.endsWith("manifest.json")) {
    event.respondWith(brandedManifest(req).catch(() => caches.match(req)));
    return;
  }

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
const LOGO_URL = "./__logo";
const BRAND_FALLBACK = "Γυμναστήριο";
let brandMemo = null;
let logoMemo = null;

async function readStored(key) {
  try {
    const cache = await caches.open(BRAND_CACHE);
    const res = await cache.match(key);
    if (res) {
      const value = (await res.text()).trim();
      if (value) return value;
    }
  } catch (e) { /* αγνόησε */ }
  return null;
}

async function writeStored(key, value) {
  try {
    const cache = await caches.open(BRAND_CACHE);
    await cache.put(key, new Response(value, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    }));
  } catch (e) { /* αγνόησε */ }
}

async function readBrand() {
  if (!brandMemo) brandMemo = await readStored(BRAND_URL);
  return brandMemo || BRAND_FALLBACK;
}

async function readLogo() {
  if (!logoMemo) logoMemo = await readStored(LOGO_URL);
  return logoMemo || "";
}

async function writeBrand(name, logo) {
  if (name && typeof name === "string" && name.trim()) {
    brandMemo = name.trim();
    await writeStored(BRAND_URL, brandMemo);
  }
  if (typeof logo === "string" && logo.trim()) {
    logoMemo = logo.trim();
    await writeStored(LOGO_URL, logoMemo);
  }
}

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg && msg.type === "brand") event.waitUntil(writeBrand(msg.name, msg.logo));
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

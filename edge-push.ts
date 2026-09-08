// ============================================================
//  Edge function: push        (slug: push)
//  ΑΝΤΙΓΡΑΦΟ ΤΟΥ ΑΝΕΒΑΣΜΕΝΟΥ ΚΩΔΙΚΑ — δεν τρέχει από εδώ.
//  Ζει στο Supabase → Edge Functions → push.
//
//  Τον καλούν δύο πράγματα:
//    - ο trigger push_on_notification, μόλις μπει ειδοποίηση
//    - το cron job push-sender, κάθε 30 δευτερόλεπτα
//
//  Τρεις δουλειές, με αυτή τη σειρά:
//    1. Φτιάχνει τις υπενθυμίσεις που ήρθε η ώρα τους.
//    2. Πετάει ό,τι είναι πολύ παλιό για να έχει νόημα.
//    3. Στέλνει την ουρά και τη σημειώνει ως σταλμένη.
// ============================================================

import { sendNotification } from "npm:web-push-neo";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:tsakirisstathis19@gmail.com";

// Ο τίτλος που βλέπει ο πελάτης στην οθόνη κλειδώματος.
const TITLES: Record<string, string> = {
  cancelled: "⚠️ Το ραντεβού σου ακυρώθηκε !⚠️",
  waitlist: "Ελευθερώθηκε θέση",
  reminder: "Υπενθύμιση προπόνησης",
};

async function rpc(fn: string, args: unknown) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(args ?? {}),
  });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/* Το όνομα το ορίζει ο διαχειριστής στις ρυθμίσεις. Το κρατάμε για
   όσο ζει η instance, δεν αξίζει κλήση σε κάθε ειδοποίηση. */
let cachedBrand: string | null = null;
async function brand(): Promise<string> {
  if (cachedBrand) return cachedBrand;
  try {
    const s = await rpc("app_settings", {});
    cachedBrand = (s && s.gym_name) || "Γυμναστήριο";
  } catch (_) {
    cachedBrand = "Γυμναστήριο";
  }
  return cachedBrand!;
}

Deno.serve(async () => {
  // Συντήρηση της ουράς. Αν σκάσει, συνεχίζουμε στην αποστολή —
  // δεν θέλουμε μια χαλασμένη υπενθύμιση να μπλοκάρει τις ακυρώσεις.
  let reminders: unknown = null;
  try { reminders = await rpc("enqueue_reminders", {}); }
  catch (e) { console.error("enqueue_reminders", String(e)); }
  try { await rpc("expire_old_notifications", {}); }
  catch (e) { console.error("expire_old_notifications", String(e)); }

  let rows: any[] = [];
  try {
    rows = (await rpc("pending_pushes", {})) ?? [];
  } catch (e) {
    console.error("pending_pushes", String(e));
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (rows.length === 0) {
    return new Response(JSON.stringify({ ok: true, reminders, sent: 0, failed: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const fallbackTitle = await brand();

  /* Μια ειδοποίηση πάει σε ΟΛΕΣ τις συσκευές του πελάτη, δηλαδή
     μπορεί να έχει πολλές γραμμές εδώ. Κρατάμε το αποτέλεσμα ανά
     ειδοποίηση: σταλμένη μετράει μόνο αν πέτυχαν όλες οι συσκευές
     της. Αλλιώς ξαναμπαίνει στην ουρά — το tag είναι ίδιο, οπότε
     όποιος την πήρε ήδη δεν βλέπει δεύτερη, απλώς αντικαθίσταται. */
  const okCount = new Map<string, number>();
  const failCount = new Map<string, number>();
  const bump = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);

  for (const r of rows) {
    /* Το ίδιο tag με αυτό που βάζει η σελίδα όταν εντοπίζει μόνη της
       την ακύρωση. Έτσι, αν ο πελάτης έχει την εφαρμογή ανοιχτή, η
       μία ειδοποίηση αντικαθιστά την άλλη αντί να έρθουν δύο. */
    const tag = r.kind === "cancelled"
      ? "kinesis-cancel-" + r.notification_id
      : "kinesis-" + r.notification_id;

    const payload = JSON.stringify({
      title: TITLES[r.kind] ?? fallbackTitle,
      body: r.body,
      tag: tag,
      url: "./index.html",
    });

    try {
      await sendNotification(
        { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
        payload,
        {
          vapidDetails: {
            subject: VAPID_SUBJECT,
            publicKey: VAPID_PUBLIC,
            privateKey: VAPID_PRIVATE,
          },
          TTL: 3600,
          urgency: "high",
        },
      );
      bump(okCount, r.notification_id);
    } catch (e: any) {
      const code = e?.statusCode;
      // 404/410 σημαίνει ότι η συνδρομή δεν ισχύει πια — π.χ. ο
      // πελάτης έσβησε την εφαρμογή. Τη βγάζουμε από τη βάση και
      // δεν τη μετράμε ως αποτυχία: δεν υπάρχει τίποτα να ξαναπάει.
      if (code === 404 || code === 410) {
        try { await rpc("drop_push_subscription", { p_endpoint: r.endpoint, p_reason: String(code) }); } catch (_) { /* ignore */ }
        bump(okCount, r.notification_id);
      } else {
        bump(failCount, r.notification_id);
        console.error("push failed", code, String(e));
      }
    }
  }

  const done: string[] = [];
  const retry: string[] = [];
  for (const id of new Set([...okCount.keys(), ...failCount.keys()])) {
    if ((failCount.get(id) ?? 0) === 0) done.push(id);
    else retry.push(id);
  }

  if (done.length) {
    try { await rpc("mark_pushed", { p_ids: done }); }
    catch (e) { console.error("mark_pushed", String(e)); }
  }
  // Μία προσπάθεια πάνω. Στις 5 η βάση τα παρατάει μόνη της, ώστε μια
  // μόνιμα χαλασμένη συνδρομή να μη ζορίζει την ουρά για πάντα.
  if (retry.length) {
    try { await rpc("mark_push_tried", { p_ids: retry }); }
    catch (e) { console.error("mark_push_tried", String(e)); }
  }

  return new Response(JSON.stringify({
    ok: true, reminders, sent: done.length, retry: retry.length,
  }), { headers: { "Content-Type": "application/json" } });
});

// =====================================================================
// SmartID Sälj-CRM · Supabase Edge Function: invite-seller
// =====================================================================
// Skapar ett inloggningskonto för en ny säljare/coach och bjuder in
// hen via e-post. Anropas från CRM:t (fliken "Säljare") med
//   sb.functions.invoke('invite-seller', { body:{ name, email, role } })
//
// SÄKERHET: funktionen verifierar att anroparen är en INLOGGAD COACH
// innan den gör något. service_role-nyckeln används bara här på servern
// och lämnar aldrig webbläsaren.
//
// --- DEPLOY (görs av Chrome-chatten, en gång) -------------------------
//   1. Lägg filen som:  supabase/functions/invite-seller/index.ts
//   2. Deploya:         supabase functions deploy invite-seller
//   (SUPABASE_URL, SUPABASE_ANON_KEY och SUPABASE_SERVICE_ROLE_KEY finns
//    automatiskt som miljövariabler i Edge Functions – inget att sätta.)
//   3. Se till att Authentication → URL Configuration → Site URL pekar på
//      https://smartid-salj-crm.vercel.app  så inbjudningslänken funkar.
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Svarar alltid med HTTP 200 – resultatet bärs i { ok, error, message }.
function json(obj: unknown) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // --- 1. Verifiera att anroparen är en inloggad COACH -------------
    const authHeader = req.headers.get("Authorization") || "";
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: authErr } =
      await callerClient.auth.getUser();
    if (authErr || !caller) {
      return json({ ok: false, error: "Du måste vara inloggad." });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: callerProfile } = await admin
      .from("profiles").select("role").eq("id", caller.id).maybeSingle();
    if (!callerProfile || callerProfile.role !== "coach") {
      return json({ ok: false, error: "Endast coacher kan bjuda in säljare." });
    }

    // --- 2. Validera indata ------------------------------------------
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const role = body.role === "coach" ? "coach" : "saljare";
    if (!name) return json({ ok: false, error: "Namn saknas." });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ ok: false, error: "Ogiltig e-postadress." });
    }

    // --- 3. Bjud in auth-användaren (skickar inbjudningsmejl) --------
    const { data: invited, error: inviteErr } =
      await admin.auth.admin.inviteUserByEmail(email);
    if (inviteErr || !invited?.user) {
      const m = inviteErr?.message || "okänt fel";
      const friendly = /already|registered|exists/i.test(m)
        ? "E-postadressen är redan registrerad."
        : "Kunde inte skicka inbjudan: " + m;
      return json({ ok: false, error: friendly });
    }
    const newUserId = invited.user.id;

    // --- 4. Skapa/uppdatera sellers-raden ----------------------------
    const { data: sellerRow, error: sellerErr } = await admin
      .from("sellers")
      .upsert({ name, email, user_id: newUserId, active: true },
              { onConflict: "email" })
      .select().single();
    if (sellerErr || !sellerRow) {
      return json({
        ok: false,
        error: "Kontot skapades men säljarraden misslyckades: " +
               (sellerErr?.message || "okänt fel"),
      });
    }

    // --- 5. Sätt profiles-raden (triggern kan redan ha skapat den) ---
    const { error: profErr } = await admin
      .from("profiles")
      .upsert({ id: newUserId, full_name: name, role, seller_id: sellerRow.id },
              { onConflict: "id" });
    if (profErr) {
      return json({
        ok: false,
        error: "Kontot skapades men profilen misslyckades: " + profErr.message,
      });
    }

    return json({
      ok: true,
      message: `Inbjudan skickad till ${email}. Personen sätter sitt lösenord via mejlet.`,
      seller_id: sellerRow.id,
    });
  } catch (e) {
    return json({ ok: false, error: "Serverfel: " + ((e as Error)?.message || String(e)) });
  }
});

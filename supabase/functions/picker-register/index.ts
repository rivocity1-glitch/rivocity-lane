import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";

function makeId() {
  return `Rpicker-${Math.floor(1000 + Math.random() * 9000)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const fullName = String(body.full_name || "").trim();
    const phone = String(body.phone || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const city = String(body.city || "").trim();
    const locality = String(body.locality || "").trim();
    const pincode = String(body.pincode || "").trim();
    const password = String(body.password || "");
    const latitude = body.latitude ?? null;
    const longitude = body.longitude ?? null;

    if (!fullName || !phone || !email || !city || !password) return new Response(JSON.stringify({ error: "Fill all required fields." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (pincode && !/^\d{6}$/.test(pincode)) return new Response(JSON.stringify({ error: "Pincode must be exactly 6 digits." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (password.length > 4) return new Response(JSON.stringify({ error: "Password must be maximum 4 characters." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const secret = secretKeys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, secret);

    let loginId = "";
    for (let i = 0; i < 20; i++) {
      const candidate = makeId();
      const { data: exists } = await admin.from("picker_profiles").select("id").eq("picker_login_id", candidate).maybeSingle();
      if (!exists) { loginId = candidate; break; }
    }
    if (!loginId) throw new Error("Could not generate a unique Picker ID.");

    const { data: created, error: authError } = await admin.auth.admin.createUser({
      email, password, email_confirm: false,
      user_metadata: { full_name: fullName, phone, city, locality, pincode }
    });
    if (authError) throw authError;
    if (!created.user) throw new Error("Picker account was not created.");

    const { error: profileError } = await admin.from("picker_profiles").insert({
      auth_user_id: created.user.id,
      picker_login_id: loginId,
      email,
      full_name: fullName,
      phone,
      city,
      locality: locality || null,
      pincode: pincode || null,
      latitude,
      longitude,
      availability_status: "offline",
      application_status: "pending",
      registration_source: "pwa"
    });

    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);
      throw profileError;
    }

    return new Response(JSON.stringify({ picker_login_id: loginId, email }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unable to register Picker." }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
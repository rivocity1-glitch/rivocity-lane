import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { picker_login_id, password } = await req.json();
    const loginId = String(picker_login_id || "").trim();
    const pass = String(password || "");
    if (!/^Rpicker-\d{4}$/.test(loginId) || pass.length < 1 || pass.length > 4) {
      return new Response(JSON.stringify({ error: "Invalid Picker credentials." }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const secret = secretKeys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const publicKeys = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}");
    const publishable = publicKeys.default || Deno.env.get("SUPABASE_ANON_KEY") || "";
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, secret);
    const client = createClient(Deno.env.get("SUPABASE_URL")!, publishable);

    const { data: profile, error } = await admin
      .from("picker_profiles")
      .select("email,application_status")
      .eq("picker_login_id", loginId)
      .maybeSingle();

    if (error || !profile?.email) {
      return new Response(JSON.stringify({ error: "Picker ID or password is incorrect." }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (profile.application_status !== "approved") {
      return new Response(JSON.stringify({ error: "Picker account is not approved." }), { status: 403, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const { data, error: authError } = await client.auth.signInWithPassword({
      email: profile.email,
      password: pass,
    });
    if (authError || !data.session) {
      return new Response(JSON.stringify({ error: "Picker ID or password is incorrect." }), { status: 401, headers: { ...cors, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      },
    }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch {
    return new Response(JSON.stringify({ error: "Unable to sign in." }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
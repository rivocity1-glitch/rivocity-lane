import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error("Picker login function is missing required Supabase secrets.");
    return jsonResponse({ error: "Picker sign-in is temporarily unavailable." }, 503);
  }

  let body: { pickerId?: unknown; pin?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request." }, 400);
  }

  const pickerId = typeof body.pickerId === "string" ? body.pickerId.trim().toUpperCase() : "";
  const pin = typeof body.pin === "string" ? body.pin : "";
  if (!/^PC-[0-9]{4}$/.test(pickerId) || pin.length < 1 || pin.length > 4) {
    return jsonResponse({ error: "Enter a valid Picker ID and a password of up to 4 characters." }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data: profile, error: profileError } = await admin
      .from("picker_profiles")
      .select("email")
      .eq("picker_login_id", pickerId)
      .maybeSingle();

    if (profileError) {
      console.error("Picker profile lookup failed:", profileError.message);
      return jsonResponse({ error: "Unable to verify these credentials. Try again." }, 503);
    }
    if (!profile?.email) {
      return jsonResponse({ error: "Picker ID or PIN is incorrect." }, 401);
    }

    // Existing registrations store the four-digit PIN using this Auth password
    // convention. The email is resolved only on the server and is never returned.
    const { data, error: authError } = await authClient.auth.signInWithPassword({
      email: profile.email,
      password: "Rivo@" + pin,
    });

    if (authError || !data.session) {
      return jsonResponse({ error: "Picker ID or PIN is incorrect." }, 401);
    }

    return jsonResponse({
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
      },
    });
  } catch (error) {
    console.error("Picker sign-in failed:", error);
    return jsonResponse({ error: "Picker sign-in is temporarily unavailable." }, 503);
  }
});

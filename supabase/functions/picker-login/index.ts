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
    const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    const clientIp = request.headers.get("cf-connecting-ip") || forwardedFor || "unknown";
    const keyBytes = new TextEncoder().encode(`${clientIp}:${pickerId}`);
    const digest = await crypto.subtle.digest("SHA-256", keyBytes);
    const rateLimitKey = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    const { data: canTry, error: rateLimitError } = await admin.rpc("consume_picker_login_attempt", {
      p_key_hash: rateLimitKey,
      p_failed: false,
      p_success: false,
    });
    if (rateLimitError) {
      console.error("Picker login rate-limit check failed:", rateLimitError.message);
      return jsonResponse({ error: "Picker sign-in is temporarily unavailable." }, 503);
    }
    if (canTry !== true) {
      return jsonResponse({ error: "Too many unsuccessful attempts. Try again in 15 minutes." }, 429);
    }

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
      await admin.rpc("consume_picker_login_attempt", {
        p_key_hash: rateLimitKey, p_failed: true, p_success: false,
      });
      return jsonResponse({ error: "Picker ID or password is incorrect." }, 401);
    }

    // Existing registrations store the four-digit PIN using this Auth password
    // convention. The email is resolved only on the server and is never returned.
    const { data, error: authError } = await authClient.auth.signInWithPassword({
      email: profile.email,
      password: "Rivo@" + pin,
    });

    if (authError || !data.session) {
      const { data: canContinue, error: recordError } = await admin.rpc("consume_picker_login_attempt", {
        p_key_hash: rateLimitKey, p_failed: true, p_success: false,
      });
      if (recordError) console.error("Picker login failure could not be rate-limited:", recordError.message);
      if (canContinue === false) {
        return jsonResponse({ error: "Too many unsuccessful attempts. Try again in 15 minutes." }, 429);
      }
      return jsonResponse({ error: "Picker ID or password is incorrect." }, 401);
    }

    const { error: clearError } = await admin.rpc("consume_picker_login_attempt", {
      p_key_hash: rateLimitKey, p_failed: false, p_success: true,
    });
    if (clearError) console.error("Picker login success could not clear rate limit:", clearError.message);

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

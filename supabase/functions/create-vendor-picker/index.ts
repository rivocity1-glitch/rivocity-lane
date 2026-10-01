import { withSupabase } from "npm:@supabase/server@1";

function pickerId() {
  return `Rpicker-${Math.floor(1000 + Math.random() * 9000)}`;
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    try {
      const body = await req.json();
      const fullName = String(body.full_name || "").trim();
      const phone = String(body.phone || "").trim();
      const email = String(body.email || "").trim().toLowerCase();
      const city = String(body.city || "").trim();
      const locality = String(body.locality || "").trim();
      const pincode = String(body.pincode || "").trim();
      const password = String(body.password || "");

      if (!fullName || !phone || !email || !city) return Response.json({ error: "Name, phone, email and city are required." }, { status: 400 });
      if (pincode && !/^\d{6}$/.test(pincode)) return Response.json({ error: "Pincode must be exactly 6 digits." }, { status: 400 });
      if (password.length < 1 || password.length > 4) return Response.json({ error: "Picker password must be maximum 4 characters." }, { status: 400 });

      const { data: vendor, error: vendorError } = await ctx.supabaseAdmin
        .from("vendors").select("id").eq("auth_user_id", ctx.userClaims?.sub).maybeSingle();
      if (vendorError) throw vendorError;
      if (!vendor) return Response.json({ error: "Vendor profile not found." }, { status: 403 });

      let loginId = "";
      for (let i = 0; i < 20; i++) {
        const candidate = pickerId();
        const { data: exists } = await ctx.supabaseAdmin.from("picker_profiles").select("id").eq("picker_login_id", candidate).maybeSingle();
        if (!exists) { loginId = candidate; break; }
      }
      if (!loginId) return Response.json({ error: "Could not generate a unique Picker ID." }, { status: 409 });

      const { data: created, error: authError } = await ctx.supabaseAdmin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { full_name: fullName, phone, city, locality, pincode }
      });
      if (authError) throw authError;
      if (!created.user) throw new Error("Auth account was not created.");

      const { data: profile, error: profileError } = await ctx.supabaseAdmin.from("picker_profiles").insert({
        auth_user_id: created.user.id, picker_login_id: loginId, email,
        full_name: fullName, phone, city, locality: locality || null,
        pincode: pincode || null, application_status: "approved",
        availability_status: "offline", registration_source: "vendor",
        created_by_vendor_id: vendor.id
      }).select("id,picker_login_id,email,full_name").single();

      if (profileError) throw profileError;

      const { error: workerError } = await ctx.supabaseAdmin.from("vendor_workers").insert({
        vendor_id: vendor.id, auth_user_id: created.user.id,
        worker_name: fullName, status: "active"
      });
      if (workerError) throw workerError;

      return Response.json({ picker: profile });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "Unable to create Picker." }, { status: 500 });
    }
  }),
};
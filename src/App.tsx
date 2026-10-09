import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, Check, ChevronRight, Clock, Package, UserRound, History,
  LogIn, RefreshCw, MapPin, LogOut, Mail, Phone, MapPinned, Fingerprint, CalendarDays,
} from "lucide-react";
import { supabase } from "./lib/supabase";
import { SessionWorker, Task, PickerProfile } from "./types";

type Tab = "picks" | "history" | "profile";
type PickerOrder = { id: string; orderNumber: string; status: string; claimedAt: string | null; tasks: Task[] };
type RegistrationDetails = { address: string | null; createdAt: string | null };
const emptyRegistrationDetails: RegistrationDetails = { address: null, createdAt: null };

export default function App() {
  const [profile, setProfile] = useState<PickerProfile | null>(null);
  const [worker, setWorker] = useState<SessionWorker | null>(null);
  const [orders, setOrders] = useState<PickerOrder[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [historyTasks, setHistoryTasks] = useState<Task[]>([]);
  const [registrationDetails, setRegistrationDetails] = useState<RegistrationDetails>(emptyRegistrationDetails);
  const [laneName, setLaneName] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("picks");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loginId, setLoginId] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setRefreshing(true);
    setError(null);
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      if (!user) {
        setProfile(null); setWorker(null); setOrders([]); setTasks([]); setHistoryTasks([]);
        setLaneName(null); setRegistrationDetails(emptyRegistrationDetails); setLoading(false);
        return;
      }

      const { data: p, error: profileError } = await supabase
        .from("picker_profiles")
        .select("id,auth_user_id,picker_login_id,email,full_name,phone,city,locality,pincode,latitude,longitude,availability_status,application_status")
        .eq("auth_user_id", user.id).maybeSingle();
      if (profileError) throw profileError;
      if (!p) {
        await supabase.auth.signOut();
        setProfile(null); setWorker(null); setOrders([]); setTasks([]); setHistoryTasks([]);
        setLaneName(null); setLoading(false);
        setError("Your Picker profile could not be found. Please contact RivoCity support.");
        return;
      }

      const metadata = user.user_metadata || {};
      const nextProfile: PickerProfile = {
        id: p.id, authUserId: p.auth_user_id,
        pickerLoginId: p.picker_login_id || metadata.picker_login_id || "",
        email: p.email || user.email || "",
        fullName: p.full_name || metadata.full_name || "",
        phone: p.phone || metadata.phone || "",
        city: p.city || metadata.city || "",
        locality: p.locality || metadata.locality || null,
        pincode: p.pincode || metadata.pincode || null,
        latitude: p.latitude ?? metadata.latitude ?? null,
        longitude: p.longitude ?? metadata.longitude ?? null,
        availabilityStatus: p.availability_status,
        applicationStatus: p.application_status,
      };
      setProfile(nextProfile);
      setRegistrationDetails({
        address: typeof metadata.address === "string" ? metadata.address : null,
        createdAt: typeof user.created_at === "string" ? user.created_at : null,
      });

      const { data: workerRow, error: workerError } = await supabase
        .from("vendor_workers").select("id,vendor_id,auth_user_id,worker_name")
        .eq("auth_user_id", user.id).eq("status", "active").maybeSingle();
      if (workerError) throw workerError;
      if (!workerRow) {
        setWorker(null); setOrders([]); setTasks([]); setHistoryTasks([]); setLaneName(null);
        setLoading(false);
        return;
      }

      setWorker({ id: workerRow.id, vendorId: workerRow.vendor_id, authUserId: workerRow.auth_user_id, name: workerRow.worker_name });

      // Active queue deliberately excludes packed/delivered orders.
      const { data: orderRows, error: ordersError } = await supabase
        .from("orders")
        .select("id,order_number,order_status,picker_worker_id,picker_claimed_at,created_at")
        .eq("vendor_id", workerRow.vendor_id)
        .in("order_status", ["accepted", "preparing"])
        .or("picker_worker_id.is.null,picker_worker_id.eq." + workerRow.id)
        .order("created_at", { ascending: true });
      if (ordersError) throw ordersError;
      const activeOrders = orderRows || [];
      const activeOrderIds = activeOrders.map((order: any) => order.id);

      const { data: activeItemRows, error: activeItemsError } = activeOrderIds.length
        ? await supabase.from("order_items").select("id,order_id,product_id,product_name").in("order_id", activeOrderIds)
        : { data: [], error: null };
      if (activeItemsError) throw activeItemsError;
      const activeItemIds = (activeItemRows || []).map((item: any) => item.id);

      const { data: activeTaskRows, error: activeTasksError } = activeItemIds.length
        ? await supabase.from("order_item_picking_tasks")
            .select("id,order_item_id,worker_id,quantity,status,assigned_at,picked_at,vendor_id")
            .eq("vendor_id", workerRow.vendor_id).in("order_item_id", activeItemIds)
        : { data: [], error: null };
      if (activeTasksError) throw activeTasksError;

      const activeItemsById = new Map<string, any>();
      (activeItemRows || []).forEach((item: any) => activeItemsById.set(item.id, item));
      const activeOrdersById = new Map<string, any>();
      activeOrders.forEach((order: any) => activeOrdersById.set(order.id, order));

      const productIds = Array.from(new Set((activeItemRows || []).map((item: any) => item.product_id).filter(Boolean)));
      const { data: locations, error: locationsError } = productIds.length
        ? await supabase.from("product_storage_locations").select("product_id,vendor_lanes(lane_name),vendor_racks(rack_name)").in("product_id", productIds)
        : { data: [], error: null };
      if (locationsError) console.warn("Optional product locations could not be loaded:", locationsError);

      const locationByProduct = new Map<string, any>();
      (locations || []).forEach((location: any) => locationByProduct.set(location.product_id, location));
      const mappedActiveTasks: Task[] = (activeTaskRows || []).map((row: any) => {
        const item = activeItemsById.get(row.order_item_id);
        const order = item ? activeOrdersById.get(item.order_id) : null;
        const location = locationByProduct.get(item?.product_id);
        return {
          id: row.id, orderItemId: row.order_item_id, workerId: row.worker_id || "",
          orderNumber: order?.order_number || "—", productName: item?.product_name || "Product Item",
          productId: item?.product_id || "", laneName: location?.vendor_lanes?.lane_name || null,
          rackName: location?.vendor_racks?.rack_name || null, quantity: Number(row.quantity || 0),
          status: row.status === "picked" ? "picked" : "assigned",
          assignedAt: row.assigned_at || "", completedAt: row.picked_at || "",
        };
      });
      setTasks(mappedActiveTasks);
      setOrders(activeOrders.map((order: any) => ({
        id: order.id, orderNumber: order.order_number || "—", status: order.order_status,
        claimedAt: order.picker_worker_id === workerRow.id ? order.picker_claimed_at || null : null,
        tasks: mappedActiveTasks.filter(task => activeItemsById.get(task.orderItemId)?.order_id === order.id),
      })));

      // History must query all picked tasks independently of the active order status.
      const { data: historyRows, error: historyError } = await supabase
        .from("order_item_picking_tasks")
        .select("id,order_item_id,worker_id,quantity,status,assigned_at,picked_at,vendor_id")
        .eq("vendor_id", workerRow.vendor_id).eq("worker_id", workerRow.id).eq("status", "picked")
        .order("picked_at", { ascending: false }).limit(300);
      if (historyError) throw historyError;
      const historicTasks = historyRows || [];
      const historyItemIds = Array.from(new Set(historicTasks.map((row: any) => row.order_item_id)));
      const { data: historyItemRows, error: historyItemsError } = historyItemIds.length
        ? await supabase.from("order_items").select("id,order_id,product_id,product_name").in("id", historyItemIds)
        : { data: [], error: null };
      if (historyItemsError) throw historyItemsError;

      const historyItemById = new Map<string, any>();
      (historyItemRows || []).forEach((item: any) => historyItemById.set(item.id, item));
      const historyOrderIds = Array.from(new Set((historyItemRows || []).map((item: any) => item.order_id).filter(Boolean)));
      const { data: historyOrderRows, error: historyOrdersError } = historyOrderIds.length
        ? await supabase.from("orders").select("id,order_number").eq("vendor_id", workerRow.vendor_id).in("id", historyOrderIds)
        : { data: [], error: null };
      if (historyOrdersError) throw historyOrdersError;
      const historyOrderById = new Map<string, any>();
      (historyOrderRows || []).forEach((order: any) => historyOrderById.set(order.id, order));

      const mappedHistoryTasks: Task[] = historicTasks.map((row: any) => {
        const item = historyItemById.get(row.order_item_id);
        const order = item ? historyOrderById.get(item.order_id) : null;
        return {
          id: row.id, orderItemId: row.order_item_id, workerId: row.worker_id || "",
          orderNumber: order?.order_number || "—", productName: item?.product_name || "Product Item",
          productId: item?.product_id || "", laneName: null, rackName: null,
          quantity: Number(row.quantity || 0), status: "picked" as const,
          assignedAt: row.assigned_at || "", completedAt: row.picked_at || "",
        };
      });
      setHistoryTasks(mappedHistoryTasks);

      const { data: laneAssignment, error: laneError } = await supabase
        .from("vendor_lane_picker_assignments").select("vendor_lanes(lane_name)")
        .eq("worker_id", workerRow.id).eq("status", "active").maybeSingle();
      if (laneError) console.warn("Optional lane assignment could not be loaded:", laneError);
      setLaneName((laneAssignment as any)?.vendor_lanes?.lane_name || null);
    } catch (loadError: any) {
      console.error("Picker load failed:", loadError);
      setError(loadError?.message || "Failed to load Picker.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const { data: authListener } = supabase.auth.onAuthStateChange(() => {
      window.setTimeout(() => void load(), 0);
    });
    return () => authListener.subscription.unsubscribe();
  }, [load]);

  useEffect(() => {
    if (!worker) return;
    const channel = supabase.channel("picker-updates-" + worker.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: "vendor_id=eq." + worker.vendorId }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "order_item_picking_tasks", filter: "vendor_id=eq." + worker.vendorId }, () => void load())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [worker?.id, worker?.vendorId, load]);

  const availableOrders = useMemo(() => orders.filter(order => !order.claimedAt && order.tasks.some(task => task.status === "assigned")), [orders]);
  const myOrders = useMemo(() => orders.filter(order => Boolean(order.claimedAt) && order.tasks.some(task => task.status === "assigned")), [orders]);
  const completedCount = historyTasks.reduce((total, task) => total + task.quantity, 0);
  const ordersWorked = new Set(historyTasks.map(task => task.orderNumber)).size;

  function goBack() { setError(null); setTab("picks"); }

  async function claimOrder(orderId: string) {
    if (!worker) return;
    setError(null);
    const { data, error: claimError } = await supabase.rpc("claim_picker_order", { p_order_id: orderId, p_worker_id: worker.id });
    if (claimError) { setError(claimError.message); return; }
    if (data !== true) { await load(); setError("This order was already claimed by another Picker."); return; }
    await load();
  }

  async function markPicked(taskId: string) {
    if (!worker) { setError("Picker worker is not active."); return; }
    const task = tasks.find(item => item.id === taskId);
    if (!task) { await load(); return; }
    const order = orders.find(item => item.orderNumber === task.orderNumber);
    if (!order) { await load(); return; }

    const { data: claimRow, error: claimReadError } = await supabase.from("orders")
      .select("picker_worker_id").eq("id", order.id).eq("vendor_id", worker.vendorId).maybeSingle();
    if (claimReadError) { setError(claimReadError.message); return; }
    if (claimRow?.picker_worker_id !== worker.id) { await load(); setError("This order is not assigned to you."); return; }

    const now = new Date().toISOString();
    const { data, error: updateError } = await supabase.from("order_item_picking_tasks")
      .update({ status: "picked", worker_id: worker.id, picked_at: now, updated_at: now })
      .eq("id", taskId).eq("vendor_id", worker.vendorId).eq("status", "assigned")
      .select("id,status,worker_id,picked_at").maybeSingle();
    if (updateError) { setError(updateError.message); return; }
    if (!data) { await load(); return; }
    await load();
  }

  async function setAvailability(next: "available" | "offline") {
    if (!profile) return;
    setError(null);
    const { error: updateError } = await supabase.from("picker_profiles")
      .update({ availability_status: next, updated_at: new Date().toISOString() })
      .eq("id", profile.id).eq("auth_user_id", profile.authUserId);
    if (updateError) { setError(updateError.message); return; }
    setProfile({ ...profile, availabilityStatus: next });
  }

  async function signIn(event: React.FormEvent) {
    event.preventDefault(); setSigningIn(true); setError(null);
    if (!/^Rpicker-[0-9]{4}$/.test(loginId.trim()) || password.length < 1 || password.length > 4) {
      setError("Enter a valid Picker ID and a password of maximum 4 characters.");
      setSigningIn(false); return;
    }
    const { data: pickerEmail, error: pickerError } = await supabase.rpc("get_picker_login_email", { p_picker_login_id: loginId.trim() });
    if (pickerError || !pickerEmail) { setError("Picker ID not found."); setSigningIn(false); return; }
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: pickerEmail, password: "Rivo@" + password });
    if (signInError) setError(signInError.message || "Unable to sign in.");
    setSigningIn(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
    setProfile(null); setWorker(null); setOrders([]); setTasks([]); setHistoryTasks([]);
    setLaneName(null); setRegistrationDetails(emptyRegistrationDetails); setTab("picks");
  }

  if (loading) return <div className="app-viewport flex items-center justify-center px-4 text-center text-sm font-bold text-slate-500">Loading RivoCity Picker…</div>;
  if (!profile) return <RegisterOrLogin loginId={loginId} email={email} password={password} setLoginId={setLoginId} setEmail={setEmail} setPassword={setPassword} onSignIn={signIn} signingIn={signingIn} error={error} />;

  const applicationPending = profile.applicationStatus !== "approved";
  return (
    <div className="app-viewport bg-slate-50 text-slate-900">
      <header className="app-header sticky top-0 z-20 border-b bg-white">
        <div className="mx-auto flex h-16 w-full max-w-xl items-center gap-3 px-3 sm:px-4">
          {tab !== "picks" && !applicationPending ? <button type="button" onClick={goBack} aria-label="Back to orders" className="touch-target flex shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"><ArrowLeft size={20} /></button> : null}
          <div className="min-w-0 flex-1">
            <div className="truncate text-xl font-black tracking-tight">RivoCity <span className="text-emerald-600">Picker</span></div>
            <div className="text-[10px] font-bold tracking-widest text-slate-400">PICKING WORKSPACE</div>
          </div>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"><UserRound size={19} /></div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-xl px-3 py-4 pb-28 sm:px-4 sm:py-5">
        {error ? <div role="alert" className="mb-4 break-words rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
        {applicationPending ? <ApplicationState profile={profile} /> : <>
          {tab === "picks" ? <Picks worker={worker} availableOrders={availableOrders} myOrders={myOrders} laneName={laneName} onClaim={claimOrder} onPick={markPicked} /> : null}
          {tab === "history" ? <HistoryView tasks={historyTasks} completedCount={completedCount} refreshing={refreshing} onRefresh={() => void load(true)} /> : null}
          {tab === "profile" ? <Profile profile={profile} worker={worker} registrationDetails={registrationDetails} itemsPicked={completedCount} ordersWorked={ordersWorked} onAvailability={setAvailability} onRefresh={() => void load(true)} onSignOut={signOut} refreshing={refreshing} /> : null}
        </>}
      </main>
      {!applicationPending ? <nav aria-label="Main navigation" className="bottom-navigation fixed inset-x-0 bottom-0 z-30 border-t bg-white">
        <div className="mx-auto grid h-16 w-full max-w-xl grid-cols-3 px-2">
          <NavButton active={tab === "picks"} icon={<Package size={19} />} label="Orders" onClick={() => setTab("picks")} />
          <NavButton active={tab === "history"} icon={<History size={19} />} label="History" onClick={() => setTab("history")} />
          <NavButton active={tab === "profile"} icon={<UserRound size={19} />} label="Profile" onClick={() => setTab("profile")} />
        </div>
      </nav> : null}
    </div>
  );
}

function Picks({ worker, availableOrders, myOrders, laneName, onClaim, onPick }: {
  worker: SessionWorker | null; availableOrders: PickerOrder[]; myOrders: PickerOrder[]; laneName: string | null;
  onClaim: (id: string) => void; onPick: (id: string) => void;
}) {
  return <section className="space-y-5">
    <div><p className="text-sm text-slate-500">Order queue</p><h1 className="break-words text-2xl font-black">{worker?.name || "RivoCity Picker"}</h1>
      <p className="mt-1 text-sm text-slate-500">{myOrders.length ? "Complete your current order before taking another." : "Claim one complete order, then pick every item in it."}</p>
      {laneName ? <p className="mt-1 text-xs font-bold text-emerald-700">Usual Lane: {laneName}</p> : null}
    </div>
    {myOrders.length > 0 ? <div className="space-y-4"><div className="text-xs font-black uppercase tracking-wider text-emerald-700">My current order</div>
      {myOrders.map(order => <OrderCard key={order.id} order={order} claimed onClaim={onClaim} onPick={onPick} />)}
    </div> : <div className="space-y-4"><div className="text-xs font-black uppercase tracking-wider text-slate-500">Available orders</div>
      {availableOrders.length ? availableOrders.map(order => <OrderCard key={order.id} order={order} claimed={false} onClaim={onClaim} onPick={onPick} />) :
        <div className="rounded-2xl border bg-white p-6 text-center text-sm text-slate-500">No complete orders are waiting for a Picker.</div>}
    </div>}
  </section>;
}

function OrderCard({ order, claimed, onClaim, onPick }: {
  order: PickerOrder; claimed: boolean; onClaim: (id: string) => void; onPick: (id: string) => void;
}) {
  const remaining = order.tasks.filter(task => task.status !== "picked").length;
  const done = order.tasks.length - remaining;
  return <article className="min-w-0 rounded-2xl border bg-white p-3 shadow-sm sm:p-4">
    <div className="flex items-start justify-between gap-3"><div className="min-w-0">
      <div className="break-words text-xs font-black uppercase text-emerald-700">Order {order.orderNumber}</div>
      <h2 className="mt-1 text-lg font-black">{remaining === 0 && order.tasks.length ? "Order picked" : "Pick complete order"}</h2>
      <p className="mt-1 text-sm text-slate-500">{done}/{order.tasks.length} items picked</p>
    </div><div className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-black uppercase">{order.status}</div></div>
    {!claimed ? <button type="button" onClick={() => onClaim(order.id)} className="touch-button mt-4 w-full rounded-xl bg-emerald-600 py-3.5 font-black text-white hover:bg-emerald-700">Claim This Order <ChevronRight size={18} className="ml-1 inline" /></button> :
      <div className="mt-4 space-y-2">{order.tasks.map(task => <div key={task.id} className="min-w-0 rounded-xl border bg-slate-50 p-3">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0 flex-1">
          <p className="break-words font-bold">{task.productName}</p><p className="mt-1 text-xs text-slate-500">Quantity: <b className="text-slate-900">{task.quantity}</b></p>
          {task.laneName || task.rackName ? <p className="mt-1 break-words text-xs font-bold text-emerald-700">Location: {task.laneName || "Store"}{task.rackName ? " → " + task.rackName : ""}</p> : <p className="mt-1 text-xs text-slate-500">No shelf location configured.</p>}
        </div>{task.status === "picked" ? <Check className="shrink-0 text-emerald-600" size={20} /> : <Clock className="shrink-0 text-slate-300" size={20} />}</div>
        {task.status !== "picked" ? <button type="button" onClick={() => onPick(task.id)} className="touch-button mt-3 w-full rounded-xl bg-emerald-600 py-3 font-black text-white hover:bg-emerald-700">Mark Picked <ChevronRight size={17} className="ml-1 inline" /></button> : null}
      </div>)}</div>}
  </article>;
}

function RegisterOrLogin({ loginId, email, password, setLoginId, setEmail, setPassword, onSignIn, signingIn, error }: {
  loginId: string; email: string; password: string; setLoginId: (value: string) => void; setEmail: (value: string) => void;
  setPassword: (value: string) => void; onSignIn: (event: React.FormEvent) => void; signingIn: boolean; error: string | null;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [city, setCity] = useState("");
  const [locality, setLocality] = useState(""); const [address, setAddress] = useState(""); const [pincode, setPincode] = useState("");
  const [lat, setLat] = useState<number | null>(null); const [lng, setLng] = useState<number | null>(null);
  const [message, setMessage] = useState(""); const [localError, setLocalError] = useState(""); const [submitting, setSubmitting] = useState(false);

  const register = async (event: React.FormEvent) => {
    event.preventDefault(); setMessage(""); setLocalError("");
    if (!name.trim() || !phone.trim() || !city.trim() || !email.trim() || !password) { setLocalError("Fill all required fields."); return; }
    if (pincode && !/^[0-9]{6}$/.test(pincode)) { setLocalError("Pincode must be exactly 6 digits."); return; }
    setSubmitting(true);
    try {
      const { data, error: signupError } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(), password: "Rivo@" + password,
        options: { data: { picker_role: "picker", registration_source: "pwa", full_name: name.trim(), phone: phone.trim(),
          city: city.trim(), locality: locality.trim() || null, address: address.trim() || null,
          pincode: pincode.trim() || null, latitude: lat, longitude: lng } },
      });
      if (signupError) {
        if (signupError.status === 422 || /already registered|user already registered/i.test(signupError.message || "")) {
          const existingEmail = email.trim().toLowerCase();
          const { data: existingPicker } = await supabase.from("picker_profiles").select("picker_login_id").eq("email", existingEmail).maybeSingle();
          setEmail(existingEmail);
          if (existingPicker?.picker_login_id) setLoginId(existingPicker.picker_login_id);
          setMode("login");
          setMessage(existingPicker?.picker_login_id ? "This email is already registered. Your Picker ID is " + existingPicker.picker_login_id + ". Sign in with that ID and your password." : "This email is already registered. Sign in with your existing Picker ID and password.");
          return;
        }
        setLocalError(signupError.message); return;
      }
      const generatedId = data.user?.user_metadata?.picker_login_id || "assigned by RivoCity";
      setMessage(data.session ? "Registration submitted. Your Picker ID is " + generatedId + ". Your profile is pending Admin approval." :
        "Registration submitted. Your Picker ID is " + generatedId + ". Check your email to confirm your account, then wait for Admin approval.");
    } catch (registrationError: any) {
      setLocalError(registrationError?.message || "Registration failed. Please try again.");
    } finally { setSubmitting(false); }
  };

  const captureLocation = () => {
    if (!navigator.geolocation) { setLocalError("Location is not available on this device/browser."); return; }
    navigator.geolocation.getCurrentPosition(position => {
      setLat(position.coords.latitude); setLng(position.coords.longitude); setMessage("Location captured for nearby vendor matching.");
    }, () => setLocalError("Location permission was not granted."), { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  };

  return <div className="app-viewport flex items-center justify-center bg-slate-50 px-3 py-6 sm:px-4">
    <form onSubmit={mode === "login" ? onSignIn : register} className="my-auto w-full max-w-md rounded-2xl border bg-white p-4 shadow-sm sm:p-6">
      <div className="text-2xl font-black">RivoCity <span className="text-emerald-600">Picker</span></div>
      <p className="mt-1 text-sm text-slate-500">{mode === "login" ? "Worker sign in" : "Register as a Picker"}</p>
      {(error || localError) ? <div role="alert" className="mt-4 break-words rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error || localError}</div> : null}
      {message ? <div role="status" className="mt-4 break-words rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{message}</div> : null}
      {mode === "login" ? <label className="mt-5 block text-xs font-bold text-slate-600">Picker ID
        <input value={loginId} onChange={event => setLoginId(event.target.value)} placeholder="Rpicker-1234" autoComplete="username" maxLength={12} className="form-control mt-1 w-full rounded-xl border px-3" />
      </label> : <>
        <FormField label="Full name" value={name} onChange={setName} autoComplete="name" required />
        <FormField label="Mobile number" value={phone} onChange={setPhone} type="tel" autoComplete="tel" required />
        <FormField label="City" value={city} onChange={setCity} autoComplete="address-level2" required />
        <FormField label="Area / locality" value={locality} onChange={setLocality} autoComplete="address-level3" />
        <FormField label="Address" value={address} onChange={setAddress} autoComplete="street-address" />
        <FormField label="Pincode" value={pincode} onChange={value => setPincode(value.replace(/[^0-9]/g, "").slice(0, 6))} inputMode="numeric" autoComplete="postal-code" />
        <button type="button" onClick={captureLocation} className="touch-button mt-3 flex w-full items-center justify-center gap-2 rounded-xl border px-3 font-bold text-slate-700"><MapPin size={17} />{lat !== null && lng !== null ? "Location captured" : "Use current location"}</button>
        {lat !== null && lng !== null ? <p className="mt-1 break-words text-xs text-slate-500">Coordinates: {lat.toFixed(5)}, {lng.toFixed(5)}</p> : null}
        <label className="mt-3 block text-xs font-bold text-slate-600">Email
          <input value={email} onChange={event => setEmail(event.target.value)} type="email" autoComplete="email" required className="form-control mt-1 w-full rounded-xl border px-3" />
        </label>
      </>}
      <label className="mt-3 block text-xs font-bold text-slate-600">Password (maximum 4 characters)
        <input value={password} maxLength={4} onChange={event => setPassword(event.target.value.slice(0, 4))} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required className="form-control mt-1 w-full rounded-xl border px-3" />
      </label>
      <button disabled={signingIn || submitting} className="touch-button mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 font-black text-white disabled:opacity-60">
        {mode === "login" ? <><LogIn size={18} />{signingIn ? "Signing in…" : "Sign In"}</> : submitting ? "Submitting…" : "Submit Registration"}
      </button>
      <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setLocalError(""); setMessage(""); }} className="touch-button mt-2 w-full rounded-xl px-3 text-sm font-bold text-emerald-700">
        {mode === "login" ? "New Picker? Register here" : "Already registered? Sign in"}
      </button>
    </form>
  </div>;
}

function FormField({ label, value, onChange, type = "text", autoComplete, inputMode, required = false }: {
  label: string; value: string; onChange: (value: string) => void; type?: "text" | "email" | "tel"; autoComplete?: string;
  inputMode?: "text" | "numeric" | "tel" | "email"; required?: boolean;
}) {
  return <label className="mt-3 block text-xs font-bold text-slate-600">{label}
    <input value={value} onChange={event => onChange(event.target.value)} type={type} autoComplete={autoComplete} inputMode={inputMode} required={required} className="form-control mt-1 w-full rounded-xl border px-3" />
  </label>;
}

function ApplicationState({ profile }: { profile: PickerProfile }) {
  const label = profile.applicationStatus === "pending" ? "Waiting for approval" : profile.applicationStatus === "rejected" ? "Application not approved" : "Picker access paused";
  return <section className="space-y-4"><div><p className="text-sm text-slate-500">Application status</p><h1 className="text-2xl font-black">{label}</h1></div>
    <div className="rounded-2xl border bg-white p-5"><p className="text-sm text-slate-600">Your Picker profile is registered with RivoCity. An admin must approve it before vendors can request you.</p>
      <p className="mt-4 break-words text-sm font-bold text-slate-500">Location: {profile.city}{profile.locality ? " · " + profile.locality : ""}</p>
      <InfoRow label="Picker ID" value={profile.pickerLoginId} /><InfoRow label="Registered email" value={profile.email} />
    </div>
  </section>;
}

function HistoryView({ tasks, completedCount, refreshing, onRefresh }: { tasks: Task[]; completedCount: number; refreshing: boolean; onRefresh: () => void }) {
  return <section className="space-y-4">
    <div className="flex items-start justify-between gap-3"><div><p className="text-sm text-slate-500">Your completed picks</p><h1 className="text-2xl font-black">History</h1></div>
      <button type="button" onClick={onRefresh} aria-label="Refresh history" className="touch-target flex items-center justify-center rounded-xl border bg-white text-slate-700"><RefreshCw size={18} className={refreshing ? "animate-spin" : ""} /></button>
    </div>
    <div className="rounded-2xl border bg-white p-4"><p className="text-xs font-bold text-slate-500">TOTAL ITEMS PICKED</p><p className="mt-1 text-3xl font-black">{completedCount}</p><p className="mt-1 text-sm text-slate-500">{tasks.length} completed picking tasks</p></div>
    {!tasks.length ? <div className="rounded-xl border bg-white p-6 text-center text-sm text-slate-500">No completed picks found for this Picker yet.</div> :
      <div className="space-y-3">{tasks.map(task => <article key={task.id} className="flex min-w-0 items-start justify-between gap-3 rounded-xl border bg-white p-4">
        <div className="min-w-0"><div className="break-words font-bold">{task.productName}</div><div className="mt-1 break-words text-xs text-slate-500">Order {task.orderNumber} · Qty {task.quantity}</div><div className="mt-1 text-xs text-slate-500">{formatDate(task.completedAt)}</div></div>
        <Check size={19} className="mt-1 shrink-0 text-emerald-600" />
      </article>)}</div>}
  </section>;
}

function Profile({ profile, worker, registrationDetails, itemsPicked, ordersWorked, onAvailability, onRefresh, onSignOut, refreshing }: {
  profile: PickerProfile; worker: SessionWorker | null; registrationDetails: RegistrationDetails; itemsPicked: number; ordersWorked: number;
  onAvailability: (value: "available" | "offline") => void; onRefresh: () => void; onSignOut: () => void; refreshing: boolean;
}) {
  return <section className="space-y-4">
    <div className="rounded-2xl border bg-white p-4 sm:p-5"><p className="text-sm text-slate-500">Picker profile</p><h1 className="mt-1 break-words text-2xl font-black">{profile.fullName}</h1>
      <p className="mt-2 inline-flex max-w-full items-center gap-2 break-all rounded-lg bg-emerald-50 px-3 py-2 text-sm font-black text-emerald-800"><Fingerprint size={17} className="shrink-0" />{profile.pickerLoginId || "Picker ID unavailable"}</p>
      <p className="mt-2 text-xs text-slate-500">Application: <span className="font-bold capitalize">{profile.applicationStatus}</span></p>
    </div>
    <div className="rounded-2xl border bg-white p-4 sm:p-5"><h2 className="font-black">Personal details</h2><div className="mt-3 space-y-1">
      <InfoRow icon={<Phone size={16} />} label="Mobile number" value={profile.phone} /><InfoRow icon={<Mail size={16} />} label="Email" value={profile.email} />
      <InfoRow icon={<MapPin size={16} />} label="City" value={profile.city} /><InfoRow icon={<MapPinned size={16} />} label="Area / locality" value={profile.locality} />
      <InfoRow label="Address" value={registrationDetails.address} /><InfoRow label="Pincode" value={profile.pincode} />
      <InfoRow label="Coordinates" value={profile.latitude !== null && profile.longitude !== null ? profile.latitude + ", " + profile.longitude : null} />
      {registrationDetails.createdAt ? <InfoRow icon={<CalendarDays size={16} />} label="Registered on" value={formatDate(registrationDetails.createdAt)} /> : null}
    </div></div>
    <div className="rounded-2xl border bg-white p-4 sm:p-5"><h2 className="font-black">Account identifiers</h2><div className="mt-3 space-y-1">
      <InfoRow label="Picker profile ID" value={profile.id} /><InfoRow label="Auth user ID" value={profile.authUserId} />
      <InfoRow label="Vendor worker ID" value={worker?.id} /><InfoRow label="Assigned vendor ID" value={worker?.vendorId} />
    </div></div>
    <div className="rounded-2xl border bg-white p-4 sm:p-5"><p className="text-xs font-bold uppercase text-slate-400">Availability</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => onAvailability("available")} className={"touch-button rounded-xl px-2 font-bold " + (profile.availabilityStatus === "available" ? "bg-emerald-600 text-white" : "border bg-white")}>Available</button>
        <button type="button" onClick={() => onAvailability("offline")} className={"touch-button rounded-xl px-2 font-bold " + (profile.availabilityStatus === "offline" ? "bg-slate-900 text-white" : "border bg-white")}>Offline</button>
      </div><p className="mt-2 text-xs text-slate-500">Current status: <b className="capitalize">{profile.availabilityStatus}</b></p>
    </div>
    <div className="rounded-2xl border bg-white p-4 sm:p-5"><h2 className="font-black">Picking record</h2><div className="mt-3 grid grid-cols-2 gap-3">
      <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Items picked</p><p className="mt-1 text-2xl font-black">{itemsPicked}</p></div>
      <div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Orders worked</p><p className="mt-1 text-2xl font-black">{ordersWorked}</p></div>
    </div></div>
    <button type="button" onClick={onRefresh} className="touch-button flex w-full items-center justify-center gap-2 rounded-xl border bg-white px-3 font-bold"><RefreshCw size={17} className={refreshing ? "animate-spin" : ""} />Refresh profile</button>
    <button type="button" onClick={onSignOut} className="touch-button flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-3 font-bold text-red-600"><LogOut size={17} />Sign Out</button>
  </section>;
}

function InfoRow({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string | number | null | undefined }) {
  const displayValue = value === null || value === undefined || value === "" ? "Not provided" : String(value);
  return <div className="grid min-w-0 grid-cols-1 gap-1 border-b border-slate-100 py-3 last:border-b-0 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:gap-3">
    <div className="flex min-w-0 items-center gap-2 text-xs font-bold text-slate-500">{icon ? <span className="shrink-0">{icon}</span> : null}<span>{label}</span></div>
    <div className="min-w-0 break-words text-sm font-semibold text-slate-800">{displayValue}</div>
  </div>;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} aria-current={active ? "page" : undefined}
    className={"flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg text-xs font-bold transition-colors " + (active ? "text-emerald-700" : "text-slate-400 hover:text-slate-700")}>
    {icon}<span>{label}</span>
  </button>;
}

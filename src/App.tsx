import{useEffect,useMemo,useState}from"react";
import{Check,ChevronRight,Clock,Package,UserRound,History,LogIn,RefreshCw,MapPin,UserPlus,LogOut}from"lucide-react";
import{supabase}from"./lib/supabase";
import{SessionWorker,Task,PickerProfile,PickerRequest}from"./types";

type Tab="picks"|"history"|"profile"|"requests";

export default function App(){
 const[profile,setProfile]=useState<PickerProfile|null>(null);
 const[worker,setWorker]=useState<SessionWorker|null>(null);
 const[tasks,setTasks]=useState<Task[]>([]);
 const[requests,setRequests]=useState<PickerRequest[]>([]);const[laneName,setLaneName]=useState<string|null>(null);
 const[tab,setTab]=useState<Tab>("picks");
 const[loading,setLoading]=useState(true);
 const[error,setError]=useState<string|null>(null);
 const[loginId,setLoginId]=useState(""); const[email,setEmail]=useState(""); const[password,setPassword]=useState(""); const[signingIn,setSigningIn]=useState(false);

 const load=async()=>{
  setError(null);
  const{data:{user}}=await supabase.auth.getUser();
  if(!user){setProfile(null);setWorker(null);setTasks([]);setRequests([]);setLaneName(null);setLoading(false);return;}
  let{data:p,error:pe}=await supabase.from("picker_profiles").select("id,auth_user_id,picker_login_id,email,full_name,phone,city,locality,pincode,latitude,longitude,availability_status,application_status").eq("auth_user_id",user.id).maybeSingle();
  if(pe)throw pe;
  if(!p){
   // A missing picker profile means this auth account is no longer registered as a Picker.
   // Do not recreate it automatically; registration must explicitly create a new profile.
   await supabase.auth.signOut();
   setProfile(null);
   setWorker(null);
   setTasks([]);
   setRequests([]);
   setLaneName(null);
   setLoading(false);
   return;
  }
  const currentProfile:PickerProfile={id:p.id,authUserId:p.auth_user_id,pickerLoginId:p.picker_login_id||"",email:p.email||user.email||"",fullName:p.full_name,phone:p.phone,city:p.city,locality:p.locality,pincode:p.pincode,latitude:p.latitude,longitude:p.longitude,availabilityStatus:p.availability_status,applicationStatus:p.application_status};
  setProfile(currentProfile);
  const{data:w,error:we}=await supabase.from("vendor_workers").select("id,vendor_id,auth_user_id,worker_name").eq("auth_user_id",user.id).eq("status","active").maybeSingle();
  if(we)throw we;
  if(w){
   const current:SessionWorker={id:w.id,vendorId:w.vendor_id,authUserId:w.auth_user_id,name:w.worker_name};setWorker(current);
   const{data:rows,error:te}=await supabase.from("order_item_picking_tasks").select("id,order_item_id,quantity,status,assigned_at,picked_at,order_items!inner(product_id,product_name,orders!inner(order_number))").eq("worker_id",w.id).order("assigned_at",{ascending:false});
   if(te)throw te;
   const productIds=(rows||[]).map((row:any)=>row.order_items?.product_id).filter(Boolean);const{data:locs}=productIds.length?await supabase.from("product_storage_locations").select("product_id,vendor_lanes(lane_name),vendor_racks(rack_name)").in("product_id",productIds):{data:[]};const locationByProduct=new Map<string,any>();(locs||[]).forEach((x:any)=>locationByProduct.set(x.product_id,x));setTasks((rows||[]).map((row:any)=>{const loc=locationByProduct.get(row.order_items?.product_id);return{id:row.id,orderItemId:row.order_item_id,workerId:w.id,orderNumber:row.order_items?.orders?.order_number||"—",productName:row.order_items?.product_name||"Product Item",productId:row.order_items?.product_id||"",laneName:loc?.vendor_lanes?.lane_name||null,rackName:loc?.vendor_racks?.rack_name||null,quantity:Number(row.quantity||0),status:row.status==="picked"?"completed":"assigned",assignedAt:row.assigned_at||"",completedAt:row.picked_at||""}}));const{data:laneAssignment}=await supabase.from("vendor_lane_picker_assignments").select("vendor_lanes(lane_name)").eq("worker_id",w.id).eq("status","active").maybeSingle();setLaneName((laneAssignment as any)?.vendor_lanes?.lane_name||null);
  }else{setWorker(null);setTasks([]);setLaneName(null);}
  const{data:reqs,error:re}=await supabase.from("picker_vendor_requests").select("id,vendor_id,status,requested_at,vendors!inner(shop_name)").eq("picker_id",p.id).order("requested_at",{ascending:false});
  if(re)throw re;
  setRequests((reqs||[]).map((r:any)=>({id:r.id,vendorId:r.vendor_id,vendorName:r.vendors?.shop_name||"RivoCity Vendor",status:r.status,requestedAt:r.requested_at})));
  setLoading(false);
 };

 useEffect(()=>{load().catch(e=>{console.error(e);setError(e.message||"Failed to load Picker.");setLoading(false)});const{data:{subscription}}=supabase.auth.onAuthStateChange(()=>load().catch(e=>setError(e.message||"Failed to refresh Picker.")));return()=>subscription.unsubscribe()},[]);
 useEffect(()=>{if(!worker)return;const ch=supabase.channel("picker-tasks-"+worker.id).on("postgres_changes",{event:"*",schema:"public",table:"order_item_picking_tasks",filter:"worker_id=eq."+worker.id},()=>load().catch(console.error)).subscribe();return()=>{supabase.removeChannel(ch)}},[worker?.id]);

 const myTasks=useMemo(()=>tasks.filter(t=>t.status==="assigned"),[tasks]);
 const history=useMemo(()=>tasks.filter(t=>t.status==="completed").sort((a,b)=>b.completedAt.localeCompare(a.completedAt)),[tasks]);
 const completedCount=history.reduce((n,t)=>n+t.quantity,0);
 const ordersWorked=new Set(tasks.map(t=>t.orderNumber)).size;
 const pendingRequests=requests.filter(r=>r.status==="pending");

 async function markPicked(id:string){const now=new Date().toISOString();const{error}=await supabase.from("order_item_picking_tasks").update({status:"picked",picked_at:now,updated_at:now}).eq("id",id).eq("worker_id",worker?.id||"");if(error){setError(error.message);return}setTasks(v=>v.map(t=>t.id===id?{...t,status:"completed",completedAt:now}:t))}
 async function respondToRequest(id:string,accept:boolean){
  setError(null);
  if(accept){const{error}=await supabase.rpc("accept_picker_vendor_request",{p_request_id:id});if(error){setError(error.message);return}}
  else{const{error}=await supabase.from("picker_vendor_requests").update({status:"declined",responded_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",id);if(error){setError(error.message);return}}
  await load();
 }
 async function setAvailability(next:"available"|"offline"){if(!profile)return;const{error}=await supabase.from("picker_profiles").update({availability_status:next,updated_at:new Date().toISOString()}).eq("id",profile.id).eq("auth_user_id",profile.authUserId);if(error){setError(error.message);return}setProfile({...profile,availabilityStatus:next})}
 async function signIn(e:React.FormEvent){e.preventDefault();setSigningIn(true);setError(null);if(!/^Rpicker-[0-9]{4}$/.test(loginId.trim())||password.length<1||password.length>4){setError("Enter a valid Picker ID and a password of maximum 4 characters.");setSigningIn(false);return}const{data:picker,error:pickerError}=await supabase.from("picker_profiles").select("email,application_status").eq("picker_login_id",loginId.trim()).maybeSingle();if(pickerError||!picker?.email){setError("Picker ID not found.");setSigningIn(false);return}const{error}=await supabase.auth.signInWithPassword({email:picker.email,password});if(error){setError(error.message||"Unable to sign in.");setSigningIn(false);return}setSigningIn(false)}
 async function signOut(){await supabase.auth.signOut();setProfile(null);setWorker(null);setTasks([]);setRequests([])}

 if(loading)return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm font-bold text-slate-500">Loading RivoCity Picker…</div>;
 if(!profile)return <RegisterOrLogin loginId={loginId} email={email} password={password} setLoginId={setLoginId} setEmail={setEmail} setPassword={setPassword} onSignIn={signIn} signingIn={signingIn} error={error}/>;

 const applicationPending=profile.applicationStatus!=="approved";
 return <div className="min-h-screen bg-slate-50 text-slate-900">
  <header className="sticky top-0 z-20 bg-white border-b"><div className="max-w-xl mx-auto px-4 h-16 flex items-center justify-between"><div><div className="font-black text-xl tracking-tight">RivoCity <span className="text-emerald-600">Picker</span></div><div className="text-[10px] text-slate-400 font-bold tracking-widest">WORKER PWA</div></div><div className="w-9 h-9 rounded-full bg-emerald-50 text-emerald-700 flex items-center justify-center"><UserRound size={18}/></div></div></header>
  <main className="max-w-xl mx-auto px-4 py-5 pb-24">
   {error&&<div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
   {applicationPending?<ApplicationState profile={profile} onAvailability={setAvailability}/>:<>
    {tab==="picks"&&<Picks worker={worker} tasks={myTasks} laneName={laneName} onPick={markPicked}/>}
    {tab==="requests"&&<Requests requests={pendingRequests} onRespond={respondToRequest}/>}
    {tab==="history"&&<HistoryView tasks={history} completedCount={completedCount}/>}
    {tab==="profile"&&<Profile profile={profile} worker={worker} itemsPicked={completedCount} ordersWorked={ordersWorked} onAvailability={setAvailability} onRefresh={()=>load().catch(e=>setError(e.message||"Refresh failed."))} onSignOut={signOut}/>}
   </>}
  </main>
  {!applicationPending&&<nav className="fixed bottom-0 inset-x-0 bg-white border-t"><div className="max-w-xl mx-auto grid grid-cols-4 h-16">
   <NavButton active={tab==="picks"} icon={<Package size={18}/>} label="My Picks" onClick={()=>setTab("picks")}/>
   <NavButton active={tab==="requests"} icon={<UserPlus size={18}/>} label="Requests" badge={pendingRequests.length} onClick={()=>setTab("requests")}/>
   <NavButton active={tab==="history"} icon={<History size={18}/>} label="History" onClick={()=>setTab("history")}/>
   <NavButton active={tab==="profile"} icon={<UserRound size={18}/>} label="Profile" onClick={()=>setTab("profile")}/>
  </div></nav>}
 </div>
}

function RegisterOrLogin({loginId,email,password,setLoginId,setEmail,setPassword,onSignIn,signingIn,error}:{loginId:string;email:string;password:string;setLoginId:(v:string)=>void;setEmail:(v:string)=>void;setPassword:(v:string)=>void;onSignIn:(e:React.FormEvent)=>void;signingIn:boolean;error:string|null}){
 const[mode,setMode]=useState<"login"|"register">("login");const[name,setName]=useState("");const[phone,setPhone]=useState("");const[city,setCity]=useState("");const[locality,setLocality]=useState("");const[pincode,setPincode]=useState("");const[lat,setLat]=useState<number|null>(null);const[lng,setLng]=useState<number|null>(null);const[message,setMessage]=useState("");
 const register=async(e:React.FormEvent)=>{e.preventDefault();setMessage("");setErrorLocal("");if(!name||!phone||!city||!email||!password){setErrorLocal("Fill all required fields.");return}if(password.length>4){setErrorLocal("Password must be maximum 4 characters.");return}if(pincode&&!/^[0-9]{6}$/.test(pincode)){setErrorLocal("Pincode must be exactly 6 digits.");return}const{data,error}=await supabase.auth.signUp({email:email.trim().toLowerCase(),password,options:{data:{picker_role:"picker",registration_source:"pwa",full_name:name.trim(),phone:phone.trim(),city:city.trim(),locality:locality.trim()||null,pincode:pincode.trim()||null,latitude:lat,longitude:lng}}});if(error){setErrorLocal(error.message);return}setMessage(data.session?"Registration submitted. Your Picker profile is pending Admin approval.":"Registration submitted. Check your email to confirm your account, then wait for Admin approval.");};
 const[errorLocal,setErrorLocal]=useState("");
 const constloc=()=>navigator.geolocation?.getCurrentPosition(p=>{setLat(p.coords.latitude);setLng(p.coords.longitude);setMessage("Location captured for nearby vendor matching.")},()=>setErrorLocal("Location permission was not granted."));
 return <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4"><form onSubmit={mode==="login"?onSignIn:register} className="w-full max-w-sm bg-white border rounded-2xl p-6 shadow-sm"><div className="font-black text-2xl">RivoCity <span className="text-emerald-600">Picker</span></div><p className="text-sm text-slate-500 mt-1">{mode==="login"?"Worker sign in":"Register as a Picker"}</p>{(error||errorLocal)&&<div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error||errorLocal}</div>}{message&&<div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{message}</div>}
 {mode==="login"&&<label className="block text-xs font-bold text-slate-500 mt-5">Picker ID<input value={loginId} onChange={e=>setLoginId(e.target.value)} placeholder="Rpicker-1234" maxLength={12} className="mt-1 w-full border rounded-xl px-3 py-3"/></label>}{mode==="register"&&<><label className="block text-xs font-bold text-slate-500 mt-5">Full name<input value={name} onChange={e=>setName(e.target.value)} className="mt-1 w-full border rounded-xl px-3 py-3"/></label><label className="block text-xs font-bold text-slate-500 mt-3">Mobile number<input value={phone} onChange={e=>setPhone(e.target.value)} type="tel" className="mt-1 w-full border rounded-xl px-3 py-3"/></label><label className="block text-xs font-bold text-slate-500 mt-3">City<input value={city} onChange={e=>setCity(e.target.value)} className="mt-1 w-full border rounded-xl px-3 py-3"/></label><label className="block text-xs font-bold text-slate-500 mt-3">Area / locality<input value={locality} onChange={e=>setLocality(e.target.value)} className="mt-1 w-full border rounded-xl px-3 py-3"/></label><label className="block text-xs font-bold text-slate-500 mt-3">Pincode<input value={pincode} onChange={e=>setPincode(e.target.value.replace(/[^0-9]/g,"").slice(0,6))} maxLength={6} inputMode="numeric" className="mt-1 w-full border rounded-xl px-3 py-3"/></label><button type="button" onClick={constloc} className="mt-3 w-full border rounded-xl py-3 font-bold text-slate-600 flex items-center justify-center gap-2"><MapPin size={17}/>{lat?"Location captured":"Use current location"}</button></>}
 <label className={"block text-xs font-bold text-slate-500 mt-3 "+(mode==="login"?"hidden":"")}>Email<input value={email} onChange={e=>setEmail(e.target.value)} type="email" required className="mt-1 w-full border rounded-xl px-3 py-3"/></label><label className="block text-xs font-bold text-slate-500 mt-3">{mode==="login"?"Password (max 4 characters)":"Password (max 4 characters)"}<input value={password} maxLength={4} onChange={e=>setPassword(e.target.value.slice(0,4))} type="password" required className="mt-1 w-full border rounded-xl px-3 py-3"/></label><button disabled={signingIn} className="mt-5 w-full bg-emerald-600 disabled:opacity-60 text-white rounded-xl py-3.5 font-black flex items-center justify-center gap-2">{mode==="login"?<><LogIn size={18}/>{signingIn?"Signing in…":"Sign In"}</>:"Submit Registration"}</button><button type="button" onClick={()=>{setMode(mode==="login"?"register":"login");setErrorLocal("");setMessage("")}} className="mt-3 w-full text-sm font-bold text-emerald-700">{mode==="login"?"New Picker? Register here":"Already registered? Sign in"}</button></form></div>
}

function ApplicationState({profile,onAvailability}:{profile:PickerProfile;onAvailability:(v:"available"|"offline")=>void}){return <section className="space-y-4"><div><p className="text-sm text-slate-500">Application status</p><h1 className="text-2xl font-black">{profile.applicationStatus==="pending"?"Waiting for approval":profile.applicationStatus==="rejected"?"Application not approved":"Picker access paused"}</h1></div><div className="bg-white border rounded-2xl p-5"><p className="text-sm text-slate-600">Your Picker profile is registered with RivoCity. An admin must approve it before vendors can request you.</p><div className="mt-4 text-sm font-bold text-slate-500">Location: {profile.city}{profile.locality?" · "+profile.locality:""}</div></div></section>}

function Picks({worker,tasks,laneName,onPick}:{worker:SessionWorker|null;tasks:Task[];laneName:string|null;onPick:(id:string)=>void}){return <section className="space-y-4"><div><p className="text-sm text-slate-500">Assigned to</p><h1 className="text-2xl font-black">{worker?.name||"RivoCity Picker"}</h1><p className="text-sm text-slate-500 mt-1">{tasks.length?tasks.length+" items to pick":"You're all caught up."}</p>{laneName&&<p className="text-xs font-bold text-emerald-700 mt-1">Assigned Lane: {laneName}</p>}</div>{!worker&&<div className="bg-white border rounded-2xl p-8 text-center"><Check className="mx-auto text-emerald-600"/><h2 className="font-black mt-3">No vendor assigned</h2><p className="text-sm text-slate-500 mt-1">Stay available and vendors can request you.</p></div>}{tasks.map(task=><article key={task.id} className="bg-white border rounded-2xl p-4 shadow-sm"><div className="flex items-start justify-between"><div><div className="text-xs font-bold text-emerald-700 uppercase">Order {task.orderNumber}</div><h2 className="font-black text-lg mt-1">{task.productName}</h2><p className="text-sm text-slate-500 mt-1">Quantity: <b className="text-slate-900">{task.quantity}</b></p>{task.laneName&&<p className="text-xs font-bold text-emerald-700 mt-1">Location: {task.laneName}{task.rackName?" → "+task.rackName:""}</p>}</div><Clock size={18} className="text-slate-300"/></div><button onClick={()=>onPick(task.id)} className="mt-4 w-full bg-emerald-600 text-white rounded-xl py-3.5 font-black flex items-center justify-center gap-2">Mark Picked <ChevronRight size={18}/></button></article>)}</section>}

function Requests({requests,onRespond}:{requests:PickerRequest[];onRespond:(id:string,a:boolean)=>void}){return <section className="space-y-4"><div><p className="text-sm text-slate-500">Vendor opportunities</p><h1 className="text-2xl font-black">Requests</h1></div>{requests.length===0?<div className="bg-white border rounded-2xl p-8 text-center text-sm text-slate-500">No new vendor requests.</div>:requests.map(r=><div key={r.id} className="bg-white border rounded-2xl p-4"><div className="font-black">{r.vendorName}</div><p className="text-sm text-slate-500 mt-1">A nearby vendor wants you as a Picker.</p><div className="grid grid-cols-2 gap-2 mt-4"><button onClick={()=>onRespond(r.id,true)} className="rounded-xl bg-emerald-600 text-white py-3 font-black">Accept</button><button onClick={()=>onRespond(r.id,false)} className="rounded-xl border py-3 font-bold text-slate-600">Decline</button></div></div>)}</section>}

function HistoryView({tasks,completedCount}:{tasks:Task[];completedCount:number}){return <section className="space-y-4"><div><p className="text-sm text-slate-500">Your completed picks</p><h1 className="text-2xl font-black">History</h1></div><div className="bg-white border rounded-2xl p-4"><p className="text-xs text-slate-500">TOTAL ITEMS PICKED</p><p className="text-3xl font-black mt-1">{completedCount}</p></div>{tasks.length===0&&<div className="bg-white border rounded-xl p-6 text-center text-sm text-slate-500">No completed picks yet.</div>}{tasks.map(t=><div key={t.id} className="bg-white border rounded-xl p-4 flex justify-between"><div><div className="font-bold">{t.productName}</div><div className="text-xs text-slate-500">Order {t.orderNumber} · Qty {t.quantity}</div></div><Check size={19} className="text-emerald-600"/></div>)}</section>}

function Profile({profile,worker,itemsPicked,ordersWorked,onAvailability,onRefresh,onSignOut}:{profile:PickerProfile;worker:SessionWorker|null;itemsPicked:number;ordersWorked:number;onAvailability:(v:"available"|"offline")=>void;onRefresh:()=>void;onSignOut:()=>void}){return <section className="space-y-4"><div><p className="text-sm text-slate-500">Picker profile</p><h1 className="text-2xl font-black">{profile.fullName}</h1><p className="text-xs font-black text-emerald-700 mt-1">{profile.pickerLoginId}</p><p className="text-xs text-slate-500 mt-1">{profile.email}</p><p className="text-sm text-slate-500">{profile.city}{profile.locality?" · "+profile.locality:""}</p></div><div className="bg-white border rounded-2xl p-5"><p className="text-xs font-bold text-slate-400 uppercase">Availability</p><div className="flex gap-2 mt-3"><button onClick={()=>onAvailability("available")} className={"flex-1 rounded-xl py-3 font-bold "+(profile.availabilityStatus==="available"?"bg-emerald-600 text-white":"border")}>Available</button><button onClick={()=>onAvailability("offline")} className={"flex-1 rounded-xl py-3 font-bold "+(profile.availabilityStatus==="offline"?"bg-slate-900 text-white":"border")}>Offline</button></div></div><div className="bg-white border rounded-2xl p-5"><p className="text-xs font-bold text-slate-400 uppercase">Picking record</p><div className="grid grid-cols-2 gap-3 mt-4"><div className="bg-slate-50 rounded-xl p-4"><p className="text-xs text-slate-500">Items picked</p><p className="text-2xl font-black mt-1">{itemsPicked}</p></div><div className="bg-slate-50 rounded-xl p-4"><p className="text-xs text-slate-500">Orders worked</p><p className="text-2xl font-black mt-1">{ordersWorked}</p></div></div></div><button onClick={onRefresh} className="w-full border bg-white rounded-xl py-3 font-bold flex items-center justify-center gap-2"><RefreshCw size={17}/>Refresh</button><button onClick={onSignOut} className="w-full border bg-white rounded-xl py-3 font-bold text-red-600 flex items-center justify-center gap-2"><LogOut size={17}/>Sign Out</button></section>}

function NavButton({active,icon,label,badge,onClick}:{active:boolean;icon:React.ReactNode;label:string;badge?:number;onClick:()=>void}){return <button onClick={onClick} className={"relative flex flex-col items-center justify-center gap-1 text-xs font-bold "+(active?"text-emerald-700":"text-slate-400")}>{icon}<span>{label}</span>{badge? <span className="absolute top-1 right-5 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[9px] flex items-center justify-center">{badge}</span>:null}</button>}

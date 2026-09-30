import{useEffect,useMemo,useState}from"react";
import{Check,ChevronRight,Clock,Package,UserRound,History,LogIn,RefreshCw}from"lucide-react";
import{supabase}from"./lib/supabase";
import{SessionWorker,Task}from"./types";

type Tab="picks"|"history"|"profile";

export default function App(){
 const[sessionWorker,setSessionWorker]=useState<SessionWorker|null>(null);
 const[tasks,setTasks]=useState<Task[]>([]);
 const[tab,setTab]=useState<Tab>("picks");
 const[loading,setLoading]=useState(true);
 const[error,setError]=useState<string|null>(null);
 const[email,setEmail]=useState("");
 const[password,setPassword]=useState("");
 const[signingIn,setSigningIn]=useState(false);

 const refresh=async()=>{
  setError(null);
  const{data:{user}}=await supabase.auth.getUser();
  if(!user){setSessionWorker(null);setTasks([]);setLoading(false);return;}
  const{data:worker,error:workerError}=await supabase.from("vendor_workers").select("id,vendor_id,auth_user_id,worker_name").eq("auth_user_id",user.id).maybeSingle();
  if(workerError)throw workerError;
  if(!worker){setSessionWorker(null);setTasks([]);setLoading(false);return;}
  const current:SessionWorker={id:worker.id,vendorId:worker.vendor_id,authUserId:worker.auth_user_id,name:worker.worker_name};
  setSessionWorker(current);
  const{data:taskRows,error:taskError}=await supabase.from("order_item_picking_tasks").select("id,order_item_id,quantity,status,assigned_at,picked_at,order_items!inner(product_name,orders!inner(order_number))").eq("worker_id",current.id).order("assigned_at",{ascending:false});
  if(taskError)throw taskError;
  setTasks((taskRows||[]).map((row:any)=>({id:row.id,orderItemId:row.order_item_id,workerId:current.id,orderNumber:row.order_items?.orders?.order_number||"—",productName:row.order_items?.product_name||"Product Item",quantity:Number(row.quantity||0),status:row.status==="picked"?"completed":"assigned",assignedAt:row.assigned_at||"",completedAt:row.picked_at||""})));
  setLoading(false);
 };

 useEffect(()=>{refresh().catch(e=>{console.error(e);setError(e.message||"Failed to load Lane.");setLoading(false);});const{data:{subscription}}=supabase.auth.onAuthStateChange(()=>refresh().catch(e=>{console.error(e);setError(e.message||"Failed to refresh Lane.");}));return()=>subscription.unsubscribe();},[]);

 useEffect(()=>{if(!sessionWorker)return;const channel=supabase.channel(`lane-worker-${sessionWorker.id}`).on("postgres_changes",{event:"*",schema:"public",table:"order_item_picking_tasks",filter:`worker_id=eq.${sessionWorker.id}`},()=>refresh().catch(e=>console.error(e))).subscribe();return()=>{supabase.removeChannel(channel)}},[sessionWorker?.id]);

 const myTasks=useMemo(()=>tasks.filter(t=>t.status==="assigned"),[tasks]);
 const history=useMemo(()=>tasks.filter(t=>t.status==="completed").sort((a,b)=>b.completedAt.localeCompare(a.completedAt)),[tasks]);
 const completedCount=history.reduce((n,t)=>n+t.quantity,0);
 const ordersWorked=new Set(tasks.map(t=>t.orderNumber)).size;

 async function markPicked(id:string){
  const task=tasks.find(t=>t.id===id);
  if(!task||task.status==="completed")return;
  const{error}=await supabase.from("order_item_picking_tasks").update({status:"picked",picked_at:new Date().toISOString(),updated_at:new Date().toISOString()}).eq("id",id).eq("worker_id",sessionWorker?.id||"");
  if(error){setError(error.message);return;}
  setTasks(prev=>prev.map(t=>t.id===id?{...t,status:"completed",completedAt:new Date().toISOString()}:t));
 }

 async function signIn(e:React.FormEvent){e.preventDefault();setSigningIn(true);setError(null);const{error}=await supabase.auth.signInWithPassword({email:email.trim(),password});if(error)setError(error.message);setSigningIn(false)}
 async function signOut(){await supabase.auth.signOut();setSessionWorker(null);setTasks([])}

 if(loading)return <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm font-bold text-slate-500">Loading RivoCity Lane…</div>;

 if(!sessionWorker)return <Login email={email} password={password} setEmail={setEmail} setPassword={setPassword} onSubmit={signIn} signingIn={signingIn} error={error}/>;

 return <div className="min-h-screen bg-slate-50 text-slate-900">
  <header className="sticky top-0 z-20 bg-white border-b"><div className="max-w-xl mx-auto px-4 h-16 flex items-center justify-between"><div><div className="font-black text-xl tracking-tight">RivoCity <span className="text-emerald-600">Lane</span></div><div className="text-[10px] text-slate-400 font-bold tracking-widest">PICKING</div></div><div className="w-9 h-9 rounded-full bg-emerald-50 text-emerald-700 flex items-center justify-center"><UserRound size={18}/></div></div></header>
  <main className="max-w-xl mx-auto px-4 py-5 pb-24">
   {error&&<div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
   {tab==="picks"&&<Picks worker={sessionWorker} tasks={myTasks} onPick={markPicked}/>}
   {tab==="history"&&<HistoryView tasks={history} completedCount={completedCount}/>}
   {tab==="profile"&&<Profile worker={sessionWorker} itemsPicked={completedCount} ordersWorked={ordersWorked} onRefresh={()=>refresh().catch(e=>setError(e.message||"Refresh failed."))} onSignOut={signOut}/>}
  </main>
  <nav className="fixed bottom-0 inset-x-0 bg-white border-t"><div className="max-w-xl mx-auto grid grid-cols-3 h-16">
   <NavButton active={tab==="picks"} icon={<Package size={19}/>} label="My Picks" onClick={()=>setTab("picks")}/>
   <NavButton active={tab==="history"} icon={<History size={19}/>} label="History" onClick={()=>setTab("history")}/>
   <NavButton active={tab==="profile"} icon={<UserRound size={19}/>} label="Profile" onClick={()=>setTab("profile")}/>
  </div></nav>
 </div>
}

function Login({email,password,setEmail,setPassword,onSubmit,signingIn,error}:{email:string;password:string;setEmail:(v:string)=>void;setPassword:(v:string)=>void;onSubmit:(e:React.FormEvent)=>void;signingIn:boolean;error:string|null}){
 return <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4"><form onSubmit={onSubmit} className="w-full max-w-sm bg-white border rounded-2xl p-6 shadow-sm"><div className="font-black text-2xl">RivoCity <span className="text-emerald-600">Lane</span></div><p className="text-sm text-slate-500 mt-1">Worker sign in</p>{error&&<div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}<label className="block text-xs font-bold text-slate-500 mt-5">Email<input value={email} onChange={e=>setEmail(e.target.value)} type="email" required className="mt-1 w-full border rounded-xl px-3 py-3 outline-none focus:border-emerald-500"/></label><label className="block text-xs font-bold text-slate-500 mt-3">Password<input value={password} onChange={e=>setPassword(e.target.value)} type="password" required className="mt-1 w-full border rounded-xl px-3 py-3 outline-none focus:border-emerald-500"/></label><button disabled={signingIn} className="mt-5 w-full bg-emerald-600 disabled:opacity-60 text-white rounded-xl py-3.5 font-black flex items-center justify-center gap-2"><LogIn size={18}/>{signingIn?"Signing in…":"Sign In"}</button></form></div>
}

function NavButton({active,icon,label,onClick}:{active:boolean;icon:React.ReactNode;label:string;onClick:()=>void}){return <button onClick={onClick} className={"flex flex-col items-center justify-center gap-1 text-xs font-bold "+(active?"text-emerald-700":"text-slate-400")}>{icon}<span>{label}</span></button>}

function Picks({worker,tasks,onPick}:{worker:SessionWorker;tasks:Task[];onPick:(id:string)=>void}){return <section className="space-y-4">
 <div><p className="text-sm text-slate-500">Assigned to</p><h1 className="text-2xl font-black mt-0.5">{worker.name}</h1><p className="text-sm text-slate-500 mt-1">{tasks.length?tasks.length+" items to pick":"You're all caught up."}</p></div>
 {tasks.length===0&&<div className="bg-white border rounded-2xl p-8 text-center"><div className="mx-auto w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center"><Check size={24}/></div><h2 className="font-black mt-4">Nothing to pick</h2><p className="text-sm text-slate-500 mt-1">New items assigned to you will appear here.</p></div>}
 {tasks.map(task=><TaskCard key={task.id} task={task} onPick={onPick}/>)}
 </section>}

function TaskCard({task,onPick}:{task:Task;onPick:(id:string)=>void}){return <article className="bg-white border rounded-2xl p-4 shadow-sm">
 <div className="flex items-start justify-between gap-3"><div><div className="text-xs font-bold text-emerald-700 uppercase tracking-wide">Order {task.orderNumber}</div><h2 className="font-black text-lg mt-1">{task.productName}</h2><p className="text-sm text-slate-500 mt-1">Quantity: <b className="text-slate-900">{task.quantity}</b></p></div><Clock size={18} className="text-slate-300"/></div>
 <button onClick={()=>onPick(task.id)} className="mt-4 w-full bg-emerald-600 text-white rounded-xl py-3.5 font-black flex items-center justify-center gap-2">Mark Picked <ChevronRight size={18}/></button>
 </article>}

function HistoryView({tasks,completedCount}:{tasks:Task[];completedCount:number}){return <section className="space-y-4">
 <div><p className="text-sm text-slate-500">Your completed picks</p><h1 className="text-2xl font-black">History</h1></div>
 <div className="bg-white border rounded-2xl p-4"><p className="text-xs text-slate-500">TOTAL ITEMS PICKED</p><p className="text-3xl font-black mt-1">{completedCount}</p><p className="text-xs text-slate-400 mt-1">Recorded from completed Lane tasks.</p></div>
 {tasks.length===0&&<div className="bg-white border rounded-2xl p-6 text-center text-sm text-slate-500">No completed picks yet.</div>}
 {tasks.map(task=><div key={task.id} className="bg-white border rounded-xl p-4 flex justify-between items-center"><div><div className="font-bold">{task.productName}</div><div className="text-xs text-slate-500">Order {task.orderNumber} · Qty {task.quantity}</div></div><Check size={19} className="text-emerald-600"/></div>)}
 </section>}

function Profile({worker,itemsPicked,ordersWorked,onRefresh,onSignOut}:{worker:SessionWorker;itemsPicked:number;ordersWorked:number;onRefresh:()=>void;onSignOut:()=>void}){return <section className="space-y-4">
 <div><p className="text-sm text-slate-500">Worker profile</p><h1 className="text-2xl font-black">{worker.name}</h1></div>
 <div className="bg-white border rounded-2xl p-5"><p className="text-xs font-bold text-slate-400 uppercase">Picking record</p><div className="grid grid-cols-2 gap-3 mt-4"><div className="bg-slate-50 rounded-xl p-4"><p className="text-xs text-slate-500">Items picked</p><p className="text-2xl font-black mt-1">{itemsPicked}</p></div><div className="bg-slate-50 rounded-xl p-4"><p className="text-xs text-slate-500">Orders worked</p><p className="text-2xl font-black mt-1">{ordersWorked}</p></div></div></div>
 <button onClick={onRefresh} className="w-full border bg-white rounded-xl py-3 font-bold flex items-center justify-center gap-2 text-slate-600"><RefreshCw size={17}/> Refresh</button>
 <button onClick={onSignOut} className="w-full border bg-white rounded-xl py-3 font-bold text-red-600">Sign Out</button>
 </section>}

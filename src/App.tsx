import{useEffect,useMemo,useState}from"react";
import{Check,ChevronRight,Clock,Package,UserRound,History,RotateCcw}from"lucide-react";
import{demoWorkers,demoTasks}from"./data/demo";
import{Task,Worker}from"./types";
import{loadState,saveState}from"./services/storage";

type Tab="picks"|"history"|"profile";
type State={workers:Worker[];tasks:Task[]};
const initial:State={workers:demoWorkers,tasks:demoTasks};

export default function App(){
 const[state,setState]=useState<State>(()=>loadState(initial));
 const[workerId,setWorkerId]=useState(state.workers[0]?.id??"w1");
 const[tab,setTab]=useState<Tab>("picks");
 const worker=state.workers.find(w=>w.id===workerId)??state.workers[0];
 useEffect(()=>saveState(state),[state]);
 const myTasks=useMemo(()=>state.tasks.filter(t=>t.workerId===worker.id&&t.status!=="completed"),[state.tasks,worker.id]);
 const history=useMemo(()=>state.tasks.filter(t=>t.workerId===worker.id&&t.status==="completed").sort((a,b)=>b.completedAt.localeCompare(a.completedAt)),[state.tasks,worker.id]);
 const completedCount=history.reduce((n,t)=>n+t.quantity,0);
 function markPicked(id:string){setState(s=>({...s,tasks:s.tasks.map(t=>t.id===id?t.status==="completed"?t:{...t,status:"completed",completedAt:new Date().toISOString()}:t)}));}
 function reset(){setState(initial);setWorkerId(initial.workers[0]?.id??"w1");setTab("picks");}
 return <div className="min-h-screen bg-slate-50 text-slate-900">
  <header className="sticky top-0 z-20 bg-white border-b"><div className="max-w-xl mx-auto px-4 h-16 flex items-center justify-between"><div><div className="font-black text-xl tracking-tight">RivoCity <span className="text-emerald-600">Lane</span></div><div className="text-[10px] text-slate-400 font-bold tracking-widest">PICKING</div></div><div className="w-9 h-9 rounded-full bg-emerald-50 text-emerald-700 flex items-center justify-center"><UserRound size={18}/></div></div></header>
  <main className="max-w-xl mx-auto px-4 py-5 pb-24">
   {tab==="picks"&&<Picks worker={worker} tasks={myTasks} onPick={markPicked}/>}
   {tab==="history"&&<HistoryView tasks={history} completedCount={completedCount}/>}
   {tab==="profile"&&<Profile worker={worker} workers={state.workers} workerId={workerId} setWorkerId={setWorkerId} onReset={reset}/>}
  </main>
  <nav className="fixed bottom-0 inset-x-0 bg-white border-t"><div className="max-w-xl mx-auto grid grid-cols-3 h-16">
   <NavButton active={tab==="picks"} icon={<Package size={19}/>} label="My Picks" onClick={()=>setTab("picks")}/>
   <NavButton active={tab==="history"} icon={<History size={19}/>} label="History" onClick={()=>setTab("history")}/>
   <NavButton active={tab==="profile"} icon={<UserRound size={19}/>} label="Profile" onClick={()=>setTab("profile")}/>
  </div></nav>
 </div>
}
function NavButton({active,icon,label,onClick}:{active:boolean;icon:React.ReactNode;label:string;onClick:()=>void}){return <button onClick={onClick} className={"flex flex-col items-center justify-center gap-1 text-xs font-bold "+(active?"text-emerald-700":"text-slate-400")}>{icon}<span>{label}</span></button>}
function Picks({worker,tasks,onPick}:{worker:Worker;tasks:Task[];onPick:(id:string)=>void}){return <section className="space-y-4">
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
 <div className="bg-white border rounded-2xl p-4"><p className="text-xs text-slate-500">TOTAL ITEMS PICKED</p><p className="text-3xl font-black mt-1">{completedCount}</p><p className="text-xs text-slate-400 mt-1">Recorded for future worker incentives.</p></div>
 {tasks.length===0&&<div className="bg-white border rounded-2xl p-6 text-center text-sm text-slate-500">No completed picks yet.</div>}
 {tasks.map(task=><div key={task.id} className="bg-white border rounded-xl p-4 flex justify-between items-center"><div><div className="font-bold">{task.productName}</div><div className="text-xs text-slate-500">Order {task.orderNumber} · Qty {task.quantity}</div></div><Check size={19} className="text-emerald-600"/></div>)}
 </section>}
function Profile({worker,workers,workerId,setWorkerId,onReset}:{worker:Worker;workers:Worker[];workerId:string;setWorkerId:(id:string)=>void;onReset:()=>void}){return <section className="space-y-4">
 <div><p className="text-sm text-slate-500">Worker profile</p><h1 className="text-2xl font-black">{worker.name}</h1></div>
 <div className="bg-white border rounded-2xl p-5"><p className="text-xs font-bold text-slate-400 uppercase">Picking record</p><div className="grid grid-cols-2 gap-3 mt-4"><div className="bg-slate-50 rounded-xl p-4"><p className="text-xs text-slate-500">Items picked</p><p className="text-2xl font-black mt-1">{worker.itemsPicked}</p></div><div className="bg-slate-50 rounded-xl p-4"><p className="text-xs text-slate-500">Orders worked</p><p className="text-2xl font-black mt-1">{worker.ordersWorked}</p></div></div></div>
 <div className="bg-white border rounded-2xl p-5"><p className="text-sm font-bold">Test worker</p><p className="text-xs text-slate-500 mt-1">Demo only. Production will identify the worker from their account.</p><select value={workerId} onChange={e=>setWorkerId(e.target.value)} className="w-full mt-3 border rounded-xl px-3 py-3">{workers.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></div>
 <button onClick={onReset} className="w-full border bg-white rounded-xl py-3 font-bold flex items-center justify-center gap-2 text-slate-600"><RotateCcw size={17}/> Reset demo</button>
 </section>}

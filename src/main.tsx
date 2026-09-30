import React from"react";
import{createRoot}from"react-dom/client";
import"./index.css";
import App from"./App";
const root=createRoot(document.getElementById("root")!);
root.render(<React.StrictMode><App/></React.StrictMode>);
if("serviceWorker"in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js"));
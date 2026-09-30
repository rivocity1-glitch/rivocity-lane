import{Task,Worker}from"../types";
export type State={workers:Worker[];tasks:Task[]};
const KEY="rivocity-lane-worker";
export function loadState(fallback:State):State{try{const raw=localStorage.getItem(KEY);return raw?JSON.parse(raw):fallback}catch{return fallback}}
export function saveState(state:State){localStorage.setItem(KEY,JSON.stringify(state))}
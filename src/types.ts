export type TaskStatus="assigned"|"completed";
export type Worker={id:string;name:string;itemsPicked:number;ordersWorked:number};
export type Task={id:string;workerId:string;orderNumber:string;productName:string;quantity:number;status:TaskStatus;completedAt:string};
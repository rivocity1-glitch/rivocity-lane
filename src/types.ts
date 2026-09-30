export type TaskStatus="assigned"|"completed";

export type Worker={
  id:string;
  name:string;
  itemsPicked:number;
  ordersWorked:number;
};

export type Task={
  id:string;
  workerId:string;
  orderItemId:string;
  orderNumber:string;
  productName:string;
  quantity:number;
  status:TaskStatus;
  assignedAt:string;
  completedAt:string;
};

export type SessionWorker={
  id:string;
  vendorId:string;
  authUserId:string;
  name:string;
};

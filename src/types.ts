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
export type PickerProfile={
  id:string;
  authUserId:string;
  pickerLoginId:string;
  email:string;
  fullName:string;
  phone:string;
  city:string;
  locality:string|null;
  pincode:string|null;
  latitude:number|null;
  longitude:number|null;
  availabilityStatus:"available"|"offline"|"busy";
  applicationStatus:"pending"|"approved"|"rejected"|"suspended";
};
export type PickerRequest={
  id:string;
  vendorId:string;
  vendorName:string;
  status:string;
  requestedAt:string;
};
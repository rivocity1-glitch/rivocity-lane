export type Role="vendor"|"worker";
export type Lane={id:string;name:string;description:string;workerIds:string[]};
export type Worker={id:string;name:string;role:"picker"|"restocker";laneIds:string[];online:boolean};
export type Product={id:string;name:string;laneId:string;stock:number;unit:string};
export type OrderItem={id:string;productId:string;name:string;quantity:number;picked:number;laneId:string};
export type Order={id:string;orderNumber:string;customer:string;createdAt:string;status:"Pending"|"Accepted"|"Preparing"|"Packed"|"Picked Up";items:OrderItem[]};
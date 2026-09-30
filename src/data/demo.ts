import{Task,Worker}from"../types";
export const demoWorkers:Worker[]=[
{id:"w1",name:"Amit",itemsPicked:24,ordersWorked:8},
{id:"w2",name:"Rahul",itemsPicked:41,ordersWorked:13},
{id:"w3",name:"Sagar",itemsPicked:18,ordersWorked:6}
];
export const demoTasks:Task[]=[
{id:"t1",workerId:"w1",orderNumber:"ORD-356213",productName:"Aashirvaad Atta 5kg",quantity:1,status:"assigned",completedAt:""},
{id:"t2",workerId:"w1",orderNumber:"ORD-356213",productName:"Tata Salt 1kg",quantity:2,status:"assigned",completedAt:""},
{id:"t3",workerId:"w2",orderNumber:"ORD-356214",productName:"Parle-G Biscuits",quantity:3,status:"assigned",completedAt:""},
{id:"t4",workerId:"w2",orderNumber:"ORD-356214",productName:"Coca-Cola 750ml",quantity:2,status:"assigned",completedAt:""},
{id:"t5",workerId:"w3",orderNumber:"ORD-356215",productName:"Harpic 500ml",quantity:1,status:"assigned",completedAt:""}
];
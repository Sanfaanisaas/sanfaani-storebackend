import mongoose from 'mongoose';
import Order from './src/models/Order.js';
import User from './src/models/User.js';
import { env } from './src/config/env.js';

async function check() {
  await mongoose.connect(env.mongoUri);
  const order = await Order.findById("6a611bb07c190d671fc023c6");
  const user = await User.findOne({ email: "test@example.com" });
  console.log("Order User ID:", order.user.toString());
  console.log("Current User ID:", user._id.toString());
  console.log("Order full:", JSON.stringify(order));
  await mongoose.disconnect();
}
check();

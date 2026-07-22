import mongoose from 'mongoose';
import Order from './src/models/Order.js';
import User from './src/models/User.js';
import { env } from './src/config/env.js';

async function find() {
  try {
    await mongoose.connect(env.mongoUri);
    const order = await Order.findOne();
    if (order) {
      console.log('FOUND_ORDER_ID=' + order._id);
      const user = await User.findById(order.user);
      if (user) {
        console.log('FOUND_USER_EMAIL=' + user.email);
      }
    } else {
      console.log('NO_ORDER_FOUND');
    }
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

find();

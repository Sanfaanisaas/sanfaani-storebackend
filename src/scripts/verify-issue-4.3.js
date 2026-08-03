import mongoose from 'mongoose';
import Order from '../models/Order.js';
import { env } from '../config/env.js';

async function verify() {
  try {
    await mongoose.connect(env.mongoUri);
    console.log('Connected to MongoDB');

    const orders = await Order.find().limit(5);
    console.log(`Found ${orders.length} orders`);

    for (const order of orders) {
      console.log(`Order ID: ${order._id}`);
      console.log(`Items count: ${order.items.length}`);
      order.items.forEach(item => {
        console.log(`  Item: ${item.nameSnapshot}`);
        console.log(`  Price Snapshot: ${item.priceSnapshot}`);
        if (!item.nameSnapshot || item.priceSnapshot === undefined) {
          console.error('CRITICAL: Snapshot missing in order item!');
        }
      });
      
      const publicOrder = order.toPublicOrder();
      if (publicOrder.receiptUrl !== order.receiptUrl) {
         console.error('CRITICAL: receiptUrl missing in toPublicOrder!');
      } else {
         console.log('  receiptUrl verified in toPublicOrder');
      }
    }

    console.log('Verification complete.');
    process.exit(0);
  } catch (err) {
    console.error('Verification failed:', err);
    process.exit(1);
  }
}

verify();

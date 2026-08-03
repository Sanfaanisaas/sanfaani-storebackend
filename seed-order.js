import mongoose from 'mongoose';
import Order from './src/models/Order.js';
import User from './src/models/User.js';
import Variant from './src/models/Variant.js';
import { env } from './src/config/env.js';

async function seed() {
  try {
    await mongoose.connect(env.mongoUri);
    console.log('Connected to MongoDB');

    const user = await User.findOne({ email: 'test@example.com' });
    if (!user) {
      console.log('User test@example.com not found. Please run register first.');
      return;
    }

    const variant = await Variant.findOne();
    if (!variant) {
      console.log('No variants found in database. Cannot create order.');
      return;
    }

    const order = await Order.create({
      user: user._id,
      items: [{
        variant: variant._id,
        sku: variant.sku,
        name: 'Test Product',
        quantity: 1,
        price: variant.price,
        subtotal: variant.price
      }],
      shippingAddress: {
        street: '123 Test St',
        city: 'Test City',
        state: 'Test State',
        country: 'Test Country'
      },
      subtotal: variant.price,
      total: variant.price,
      paymentMethod: 'paystack',
      paymentStatus: 'pending',
      orderStatus: 'processing'
    });

    console.log('CREATED_ORDER_ID=' + order._id);
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

seed();

import mongoose from 'mongoose';
import User from '../models/User.js';
import Repair from '../models/Repair.js';
import { env } from '../config/env.js';
import { USER_ROLES } from '../utils/constants.js';

async function testTicket5_1() {
  try {
    await mongoose.connect(env.mongoUri);
    console.log('Connected to MongoDB');

    // Clean up
    await User.deleteMany({ email: 'test_customer@example.com' });
    await Repair.deleteMany({});

    // Create a test customer
    const customer = await User.create({
      name: 'Test Customer',
      email: 'test_customer@example.com',
      passwordHash: 'dummy_hash',
      role: USER_ROLES.CUSTOMER
    });

    console.log('\n--- Test 1: privacyAcknowledged: false ---');
    try {
      await Repair.create({
        customer: customer._id,
        device: { type: 'Laptop', brand: 'Apple', model: 'MacBook Pro' },
        issueDescription: 'Screen is cracked',
        privacyAcknowledged: false
      });
      console.log('FAIL: Created repair with privacyAcknowledged: false (should have failed)');
    } catch (err) {
      console.log('SUCCESS: Rejected as expected:', err.message);
    }

    console.log('\n--- Test 2: privacyAcknowledged: true ---');
    try {
      const repair = await Repair.create({
        customer: customer._id,
        device: { type: 'Laptop', brand: 'Apple', model: 'MacBook Pro' },
        issueDescription: 'Screen is cracked',
        privacyAcknowledged: true
      });
      console.log('SUCCESS: Created repair with privacyAcknowledged: true');
      console.log('Repair ID:', repair._id);
      console.log('Status:', repair.status);
    } catch (err) {
      console.log('FAIL: Could not create repair with privacyAcknowledged: true:', err.message);
    }

    await mongoose.connection.close();
  } catch (err) {
    console.error('Error during testing:', err);
    process.exit(1);
  }
}

testTicket5_1();

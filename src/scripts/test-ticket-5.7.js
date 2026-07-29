import mongoose from 'mongoose';
import User from '../models/User.js';
import Repair from '../models/Repair.js';
import Warranty from '../models/Warranty.js';
import { env } from '../config/env.js';
import { USER_ROLES, REPAIR_STATUS } from '../utils/constants.js';
import { handoverRepair } from '../services/repairService.js';

async function testTicket5_7() {
  try {
    await mongoose.connect(env.mongoUri);
    console.log('Connected to MongoDB');

    // Clean up
    await User.deleteMany({ email: /test_.*@example.com/ });
    await Repair.deleteMany({});
    await Warranty.deleteMany({});

    // Create test users
    const customer = await User.create({
      name: 'Test Customer',
      email: 'test_customer@example.com',
      passwordHash: 'dummy',
      role: USER_ROLES.CUSTOMER
    });

    // Create a repair request in READY status
    const repair = await Repair.create({
      customer: customer._id,
      device: { type: 'Laptop', brand: 'Apple', model: 'MacBook Pro' },
      issueDescription: 'Dead',
      privacyAcknowledged: true,
      status: REPAIR_STATUS.READY
    });

    console.log('\n--- Test 1: Handover for READY repair (should succeed) ---');
    try {
      const { repair: updatedRepair, warranty } = await handoverRepair(repair._id);
      console.log('SUCCESS: Handover completed');
      console.log('New Repair Status:', updatedRepair.status);
      console.log('Warranty Created:', warranty._id);
      console.log('Warranty Expires At:', warranty.expiresAt);
      console.log('Device Summary:', warranty.deviceSummary);
    } catch (err) {
      console.log('FAIL: Handover failed:', err.message);
    }

    console.log('\n--- Test 2: Handover for non-READY repair (should fail) ---');
    const repair2 = await Repair.create({
      customer: customer._id,
      device: { type: 'Phone', brand: 'Google', model: 'Pixel 7' },
      issueDescription: 'Battery',
      privacyAcknowledged: true,
      status: REPAIR_STATUS.REQUESTED
    });
    try {
      await handoverRepair(repair2._id);
      console.log('FAIL: Handover succeeded for non-READY repair');
    } catch (err) {
      console.log('SUCCESS: Rejected as expected:', err.message);
    }

    await mongoose.connection.close();
  } catch (err) {
    console.error('Error during testing:', err);
    process.exit(1);
  }
}

testTicket5_7();

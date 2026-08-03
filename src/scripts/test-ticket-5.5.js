import mongoose from 'mongoose';
import User from '../models/User.js';
import Repair from '../models/Repair.js';
import { env } from '../config/env.js';
import { USER_ROLES } from '../utils/constants.js';
import { addWorkLogEntry } from '../services/repairService.js';

async function testTicket5_5() {
  try {
    await mongoose.connect(env.mongoUri);
    console.log('Connected to MongoDB');

    // Clean up
    await User.deleteMany({ email: /test_.*@example.com/ });
    await Repair.deleteMany({});

    // Create test users
    const customer = await User.create({
      name: 'Test Customer',
      email: 'test_customer@example.com',
      passwordHash: 'dummy',
      role: USER_ROLES.CUSTOMER
    });

    const technician = await User.create({
      name: 'Technician',
      email: 'test_tech@example.com',
      passwordHash: 'dummy',
      role: USER_ROLES.TECHNICIAN
    });

    const opsManager = await User.create({
      name: 'Ops Manager',
      email: 'test_ops@example.com',
      passwordHash: 'dummy',
      role: USER_ROLES.OPS_MANAGER
    });

    // Create a repair request
    const repair = await Repair.create({
      customer: customer._id,
      device: { type: 'Laptop', brand: 'Apple', model: 'MacBook Pro' },
      issueDescription: 'Dead',
      privacyAcknowledged: true
    });

    console.log('\n--- Test 1: Add log entry by Technician ---');
    const r1 = await addWorkLogEntry(repair._id, technician._id, 'Opened the device, looks like water damage.');
    console.log('Log count:', r1.workLog.length);
    console.log('Last log note:', r1.workLog[0].note);
    console.log('Last log author:', r1.workLog[0].author.name);

    console.log('\n--- Test 2: Add another log entry by Ops Manager ---');
    const r2 = await addWorkLogEntry(repair._id, opsManager._id, 'Confirmed water damage, proceeding with quote.');
    console.log('Log count:', r2.workLog.length);
    console.log('Second log note:', r2.workLog[1].note);
    console.log('Second log author:', r2.workLog[1].author.name);

    console.log('\n--- Test 3: Verify append-only (order) ---');
    if (r2.workLog[0].note.includes('Opened') && r2.workLog[1].note.includes('Confirmed')) {
      console.log('SUCCESS: Entries are in correct order');
    } else {
      console.log('FAIL: Order is wrong');
    }

    await mongoose.connection.close();
  } catch (err) {
    console.error('Error during testing:', err);
    process.exit(1);
  }
}

testTicket5_5();

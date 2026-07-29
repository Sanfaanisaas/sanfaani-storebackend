import mongoose from 'mongoose';
import User from '../models/User.js';
import Repair from '../models/Repair.js';
import Quote from '../models/Quote.js';
import { env } from '../config/env.js';
import { USER_ROLES, QUOTE_STATUS, REPAIR_STATUS } from '../utils/constants.js';
import { createNewQuoteVersion, approveQuote, transitionToInRepair } from '../services/quoteService.js';

async function testTicket5_4() {
  try {
    await mongoose.connect(env.mongoUri);
    console.log('Connected to MongoDB');

    // Clean up
    await User.deleteMany({ email: /test_.*@example.com/ });
    await Repair.deleteMany({});
    await Quote.deleteMany({});

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

    // Create a repair request
    const repair = await Repair.create({
      customer: customer._id,
      device: { type: 'Laptop', brand: 'Apple', model: 'MacBook Pro' },
      issueDescription: 'Dead',
      privacyAcknowledged: true
    });

    console.log('\n--- Test 1: Create Quote Version 1 ---');
    const q1 = await createNewQuoteVersion(repair._id, [{ description: 'Screen', cost: 200 }], technician._id);
    console.log('Quote 1 Version:', q1.version, 'Status:', q1.status);

    console.log('\n--- Test 2: Create Quote Version 2 (supersedes q1) ---');
    const q2 = await createNewQuoteVersion(repair._id, [{ description: 'Screen + Labor', cost: 250 }], technician._id);
    const q1Reloaded = await Quote.findById(q1._id);
    console.log('Quote 1 Status after q2:', q1Reloaded.status);
    console.log('Quote 2 Version:', q2.version, 'Status:', q2.status);

    console.log('\n--- Test 3: Attempt IN_REPAIR without accepted quote (should fail) ---');
    try {
      await transitionToInRepair(repair._id);
      console.log('FAIL: Transitioned to IN_REPAIR without accepted quote');
    } catch (err) {
      console.log('SUCCESS: Rejected as expected:', err.message);
    }

    console.log('\n--- Test 4: Approve Quote 2 ---');
    await approveQuote(repair._id, q2._id, customer._id.toString(), USER_ROLES.CUSTOMER);
    const q2Approved = await Quote.findById(q2._id);
    console.log('Quote 2 Status:', q2Approved.status);

    console.log('\n--- Test 5: Transition to IN_REPAIR after approval (should succeed) ---');
    try {
      const repairFinal = await transitionToInRepair(repair._id);
      console.log('SUCCESS: Transitioned to IN_REPAIR');
      console.log('Repair Status:', repairFinal.status);
    } catch (err) {
      console.log('FAIL: Transition failed after approval:', err.message);
    }

    await mongoose.connection.close();
  } catch (err) {
    console.error('Error during testing:', err);
    process.exit(1);
  }
}

testTicket5_4();

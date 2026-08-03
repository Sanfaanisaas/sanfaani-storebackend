import mongoose from 'mongoose';
import User from '../models/User.js';
import Repair from '../models/Repair.js';
import { env } from '../config/env.js';
import { USER_ROLES, REPAIR_STATUS } from '../utils/constants.js';
import { intakeRepair } from '../services/repairService.js';

async function testTicket5_2() {
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

    // Create a repair request
    const repair = await Repair.create({
      customer: customer._id,
      device: { type: 'Laptop', brand: 'Apple', model: 'MacBook Pro' },
      issueDescription: 'Screen is cracked',
      privacyAcknowledged: true
    });
    console.log('Repair created:', repair._id);

    console.log('\n--- Test 1: Intake with no photos (should fail) ---');
    try {
      await intakeRepair(repair._id, { intakePhotos: [], intakeCondition: 'Some condition' });
      console.log('FAIL: Intake succeeded with no photos');
    } catch (err) {
      console.log('SUCCESS: Rejected as expected:', err.message);
    }

    console.log('\n--- Test 2: Intake with no condition (should fail) ---');
    try {
      await intakeRepair(repair._id, { intakePhotos: ['photo1.jpg'], intakeCondition: '' });
      console.log('FAIL: Intake succeeded with no condition');
    } catch (err) {
      console.log('SUCCESS: Rejected as expected:', err.message);
    }

    console.log('\n--- Test 3: Valid intake (should succeed) ---');
    try {
      const updatedRepair = await intakeRepair(repair._id, { 
        intakePhotos: ['photo1.jpg', 'photo2.jpg'], 
        intakeCondition: 'Scratches on the lid, screen cracked.' 
      });
      console.log('SUCCESS: Intake succeeded');
      console.log('New Status:', updatedRepair.status);
      console.log('Photos:', updatedRepair.intakePhotos);
      console.log('Condition:', updatedRepair.intakeCondition);
    } catch (err) {
      console.log('FAIL: Valid intake failed:', err.message);
    }

    await mongoose.connection.close();
  } catch (err) {
    console.error('Error during testing:', err);
    process.exit(1);
  }
}

testTicket5_2();

import mongoose from 'mongoose';
import User from '../models/User.js';
import Repair from '../models/Repair.js';
import { env } from '../config/env.js';
import { USER_ROLES, REPAIR_STATUS } from '../utils/constants.js';
import { performQC } from '../services/repairService.js';

async function testTicket5_6() {
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

    const qcOfficer = await User.create({
      name: 'QC Officer',
      email: 'test_qc@example.com',
      passwordHash: 'dummy',
      role: USER_ROLES.QC_OFFICER
    });

    // Create a repair request assigned to the technician
    const repair = await Repair.create({
      customer: customer._id,
      device: { type: 'Laptop', brand: 'Apple', model: 'MacBook Pro' },
      issueDescription: 'Dead',
      privacyAcknowledged: true,
      technician: technician._id,
      status: REPAIR_STATUS.IN_REPAIR
    });

    console.log('\n--- Test 1: Technician attempts to QC their own work (should fail 403) ---');
    try {
      await performQC(repair._id, technician._id.toString(), { passed: true, note: 'Looks good to me!' });
      console.log('FAIL: Technician succeeded in self-QC');
    } catch (err) {
      console.log('SUCCESS: Rejected as expected:', err.message, '(Status:', err.statusCode, ')');
    }

    console.log('\n--- Test 2: QC Officer fails the QC (should kick back to IN_REPAIR) ---');
    try {
      const failedRepair = await performQC(repair._id, qcOfficer._id.toString(), { passed: false, note: 'Still not charging.' });
      console.log('SUCCESS: QC Failed recorded');
      console.log('Repair Status:', failedRepair.status);
      console.log('Last Log:', failedRepair.workLog[failedRepair.workLog.length - 1].note);
    } catch (err) {
      console.log('FAIL: QC failure recording failed:', err.message);
    }

    console.log('\n--- Test 3: QC Officer passes the QC (should move to READY) ---');
    try {
      const passedRepair = await performQC(repair._id, qcOfficer._id.toString(), { passed: true, note: 'All tests passed.' });
      console.log('SUCCESS: QC Pass recorded');
      console.log('Repair Status:', passedRepair.status);
    } catch (err) {
      console.log('FAIL: QC pass recording failed:', err.message);
    }

    await mongoose.connection.close();
  } catch (err) {
    console.error('Error during testing:', err);
    process.exit(1);
  }
}

testTicket5_6();

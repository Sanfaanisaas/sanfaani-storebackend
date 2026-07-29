import mongoose from 'mongoose';
import User from '../models/User.js';
import Repair from '../models/Repair.js';
import { env } from '../config/env.js';
import { USER_ROLES } from '../utils/constants.js';
import { assignTechnician, recordDiagnosis } from '../services/repairService.js';

async function testTicket5_3() {
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

    const technicianA = await User.create({
      name: 'Technician A',
      email: 'test_tech_a@example.com',
      passwordHash: 'dummy',
      role: USER_ROLES.TECHNICIAN
    });

    const technicianB = await User.create({
      name: 'Technician B',
      email: 'test_tech_b@example.com',
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

    console.log('\n--- Test 1: Assign Technician A ---');
    await assignTechnician(repair._id, technicianA._id);
    const assignedRepair = await Repair.findById(repair._id);
    console.log('Assigned Technician:', assignedRepair.technician.toString() === technicianA._id.toString() ? 'Technician A' : 'Wrong');

    console.log('\n--- Test 2: Technician B attempts diagnosis on A\'s repair (should fail 403) ---');
    try {
      await recordDiagnosis(repair._id, technicianB._id.toString(), {
        diagnosisNotes: 'B is trying to steal the job',
        estimatedCost: 100
      });
      console.log('FAIL: Technician B succeeded in diagnosis');
    } catch (err) {
      console.log('SUCCESS: Rejected as expected:', err.message, '(Status:', err.statusCode, ')');
    }

    console.log('\n--- Test 3: Technician A attempts diagnosis (should succeed) ---');
    try {
      const diagnosedRepair = await recordDiagnosis(repair._id, technicianA._id.toString(), {
        diagnosisNotes: 'Motherboard failure detected.',
        estimatedCost: 500
      });
      console.log('SUCCESS: Diagnosis recorded');
      console.log('Notes:', diagnosedRepair.diagnosisNotes);
      console.log('Cost:', diagnosedRepair.estimatedCost);
    } catch (err) {
      console.log('FAIL: Technician A failed diagnosis:', err.message);
    }

    await mongoose.connection.close();
  } catch (err) {
    console.error('Error during testing:', err);
    process.exit(1);
  }
}

testTicket5_3();

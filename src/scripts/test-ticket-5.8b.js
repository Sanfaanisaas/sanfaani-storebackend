import mongoose from 'mongoose';
import User from '../models/User.js';
import Repair from '../models/Repair.js';
import Quote from '../models/Quote.js';
import { env } from '../config/env.js';
import { USER_ROLES, REPAIR_STATUS, QUOTE_STATUS } from '../utils/constants.js';
import { getRepairStatus } from '../services/repairService.js';

async function testTicket5_8b() {
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

    // Create a repair request with internal data
    const repair = await Repair.create({
      customer: customer._id,
      device: { type: 'Laptop', brand: 'Apple', model: 'MacBook Pro', serialNumber: 'SN12345' },
      issueDescription: 'Dead',
      privacyAcknowledged: true,
      technician: technician._id,
      intakeCondition: 'Very bad',
      diagnosisNotes: 'Internal spill',
      workLog: [{ note: 'Started working', author: technician._id }]
    });

    // Create an accepted quote
    await Quote.create({
      repair: repair._id,
      version: 1,
      lineItems: [{ description: 'Mainboard', cost: 500 }],
      total: 500,
      status: QUOTE_STATUS.ACCEPTED,
      createdBy: technician._id
    });

    console.log('\n--- Test 1: Get Public Tracking Info ---');
    const publicData = await getRepairStatus(repair._id);
    console.log('Public Data:', JSON.stringify(publicData, null, 2));

    // Validations
    const internalFields = ['technician', 'workLog', 'intakeCondition', 'diagnosisNotes', 'serialNumber'];
    internalFields.forEach(field => {
      if (publicData[field] !== undefined || (publicData.device && publicData.device[field] !== undefined)) {
        console.log(`FAIL: Internal field '${field}' is exposed!`);
      } else {
        console.log(`SUCCESS: Internal field '${field}' is hidden.`);
      }
    });

    if (publicData.quoteTotal === 500) {
      console.log('SUCCESS: quoteTotal is present for accepted quote');
    } else {
      console.log('FAIL: quoteTotal missing or wrong');
    }

    await mongoose.connection.close();
  } catch (err) {
    console.error('Error during testing:', err);
    process.exit(1);
  }
}

testTicket5_8b();

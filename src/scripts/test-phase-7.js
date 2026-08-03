import mongoose from 'mongoose';
import User from '../models/User.js';
import Repair from '../models/Repair.js';
import Warranty from '../models/Warranty.js';
import Claim from '../models/Claim.js';
import SupportTicket from '../models/SupportTicket.js';
import AuditLog from '../models/AuditLog.js';
import { env } from '../config/env.js';
import { USER_ROLES, REPAIR_STATUS, CLAIM_STATUS, SUPPORT_TICKET_STATUS } from '../utils/constants.js';
import * as claimController from '../controllers/claimController.js';
import * as supportTicketController from '../controllers/supportTicketController.js';
import { getSupportOfficerQueue } from '../services/dashboardService.js';

// Mock express response
const mockRes = () => {
  const res = { body: {} };
  res.status = function(code) {
    this.statusCode = code;
    return this;
  };
  res.json = function(data) {
    this.body = data;
    return this;
  };
  return res;
};

const mockNext = (err) => {
  if (err) throw err;
};

async function testPhase7() {
  try {
    await mongoose.connect(env.mongoUri);
    console.log('Connected to MongoDB');

    // Clean up
    await User.deleteMany({ email: /test_.*@example.com/ });
    await Repair.deleteMany({});
    await Warranty.deleteMany({});
    await Claim.deleteMany({});
    await SupportTicket.deleteMany({});
    await AuditLog.deleteMany({});

    // Create test users
    const customer = await User.create({
      name: 'Test Customer',
      email: 'test_customer@example.com',
      passwordHash: 'dummy',
      role: USER_ROLES.CUSTOMER
    });

    const supportOfficer = await User.create({
      name: 'Test Support',
      email: 'test_support@example.com',
      passwordHash: 'dummy',
      role: USER_ROLES.SUPPORT_OFFICER
    });

    // 1. Warranty Claims Tests
    console.log('\n--- 1. Warranty Claims Tests ---');

    // Create valid warranty
    const validWarranty = await Warranty.create({
      repair: new mongoose.Types.ObjectId(),
      customer: customer._id,
      deviceSummary: 'MacBook Pro 16',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days from now
    });

    // Create expired warranty
    const expiredWarranty = await Warranty.create({
      repair: new mongoose.Types.ObjectId(),
      customer: customer._id,
      deviceSummary: 'iPhone 12',
      expiresAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) // 1 day ago
    });

    console.log('Test 1.1: Claim on valid warranty (should succeed)');
    const req1 = {
      params: { id: validWarranty._id.toString() },
      body: { description: 'Screen flickering' },
      user: { id: customer._id.toString(), _id: customer._id }
    };
    const res1 = mockRes();
    await claimController.createClaim(req1, res1, mockNext);
    // controllers use catchAsync, so we need to wait if it's a promise, but catchAsync returns a function that returns nothing.
    // However, createClaim itself IS async.
    // Actually, catchAsync(fn) returns (req, res, next) => { fn(req, res, next).catch(next) }
    // So we need to call it and wait for the inner promise if we can.
    // But we don't have access to it easily.
    // Let's modify the test to wait a bit or use the controller functions directly WITHOUT catchAsync if possible.
    // Or just await the call if it's the raw function.
    
    // Wait for async operations to complete
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('Result:', res1.statusCode, res1.body?.success ? 'SUCCESS' : 'FAIL');
    const claim = res1.body?.data;
    if (!claim) {
      console.log('DEBUG res1.body:', JSON.stringify(res1.body));
    }

    console.log('\nTest 1.2: Claim on expired warranty (should fail)');
    const req2 = {
      params: { id: expiredWarranty._id.toString() },
      body: { description: 'Battery issue' },
      user: { id: customer._id.toString(), _id: customer._id }
    };
    const res2 = mockRes();
    try {
      await claimController.createClaim(req2, res2, mockNext);
    } catch (err) {
      console.log('Caught expected error:', err.statusCode, err.message);
    }

    console.log('\nTest 1.3: Valid status transition (SUBMITTED -> UNDER_REVIEW)');
    const req3 = {
      params: { id: claim._id.toString() },
      body: { status: CLAIM_STATUS.UNDER_REVIEW },
      user: { id: supportOfficer._id.toString(), _id: supportOfficer._id, role: supportOfficer.role }
    };
    const res3 = mockRes();
    await claimController.updateClaimStatus(req3, res3, mockNext);
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log('Result:', res3.statusCode, res3.body.data.status);

    // Verify Audit Log
    const auditLog = await AuditLog.findOne({ targetId: claim._id });
    console.log('Audit Log created:', auditLog ? 'YES' : 'NO', 'Action:', auditLog?.action);

    console.log('\nTest 1.4: Invalid status transition (UNDER_REVIEW -> RESOLVED)');
    const req4 = {
      params: { id: claim._id.toString() },
      body: { status: CLAIM_STATUS.RESOLVED },
      user: { id: supportOfficer._id.toString(), _id: supportOfficer._id, role: supportOfficer.role }
    };
    const res4 = mockRes();
    try {
      await claimController.updateClaimStatus(req4, res4, mockNext);
    } catch (err) {
      console.log('Caught expected error:', err.statusCode, err.message);
    }

    // 2. Support Tickets Tests
    console.log('\n--- 2. Support Tickets Tests ---');

    console.log('Test 2.1: Create support ticket');
    const req5 = {
      body: { subject: 'Delayed delivery', message: 'My order is late' },
      user: { id: customer._id.toString(), _id: customer._id }
    };
    const res5 = mockRes();
    await supportTicketController.createSupportTicket(req5, res5, mockNext);
    await new Promise(resolve => setTimeout(resolve, 500));
    const ticket = res5.body.data;
    console.log('Result:', res5.statusCode, 'Ticket ID:', ticket._id);

    console.log('\nTest 2.2: Customer reply');
    const req6 = {
      params: { id: ticket._id.toString() },
      body: { body: 'Any updates?' },
      user: { id: customer._id.toString(), _id: customer._id }
    };
    const res6 = mockRes();
    await supportTicketController.replyToTicket(req6, res6, mockNext);
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log('Result:', res6.statusCode, 'Messages count:', res6.body.data.messages.length);

    console.log('\nTest 2.3: Support reply');
    const req7 = {
      params: { id: ticket._id.toString() },
      body: { body: 'We are looking into it' },
      user: { id: supportOfficer._id.toString(), _id: supportOfficer._id, role: supportOfficer.role }
    };
    const res7 = mockRes();
    await supportTicketController.replyToTicket(req7, res7, mockNext);
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log('Result:', res7.statusCode, 'Messages count:', res7.body.data.messages.length);

    console.log('\nTest 2.4: Support Officer Queue');
    // Using the service directly as controllers use it
    const queue = await getSupportOfficerQueue();
    console.log('Queue items count:', queue.length);
    console.log('First item subject:', queue[0]?.subject);
    console.log('First item customer name:', queue[0]?.customer?.name);

    await mongoose.connection.close();
  } catch (err) {
    console.error('Error during testing:', err);
    process.exit(1);
  }
}

testPhase7();

import Quote from "../models/Quote.js";
import Repair from "../models/Repair.js";
import AppError from "../utils/AppError.js";
import { QUOTE_STATUS, REPAIR_STATUS } from "../utils/constants.js";

export const createNewQuoteVersion = async (repairId, lineItems, userId) => {
  const repair = await Repair.findById(repairId);
  if (!repair) {
    throw new AppError("Repair not found.", 404);
  }

  // Atomically supersede existing SENT or VIEWED quotes for this repair
  await Quote.updateMany(
    { 
      repair: repairId, 
      status: { $in: [QUOTE_STATUS.SENT, QUOTE_STATUS.VIEWED] } 
    },
    { $set: { status: QUOTE_STATUS.SUPERSEDED } }
  );

  // Get the latest version number
  const latestQuote = await Quote.findOne({ repair: repairId }).sort({ version: -1 });
  const nextVersion = latestQuote ? latestQuote.version + 1 : 1;

  const total = lineItems.reduce((acc, item) => acc + item.cost, 0);

  const newQuote = await Quote.create({
    repair: repairId,
    version: nextVersion,
    lineItems,
    total,
    status: QUOTE_STATUS.SENT,
    createdBy: userId
  });

  // Automatically update repair status to QUOTE_SENT
  repair.status = REPAIR_STATUS.QUOTE_SENT;
  await repair.save();

  return newQuote;
};

export const approveQuote = async (repairId, quoteId, userId, userRole) => {
  const repair = await Repair.findById(repairId);
  if (!repair) {
    throw new AppError("Repair not found.", 404);
  }

  // Auth: Customer of the repair or admin
  const isCustomer = repair.customer.toString() === userId;
  const isAdmin = ["ops_manager", "super_admin"].includes(userRole);
  
  if (!isCustomer && !isAdmin) {
    throw new AppError("Not authorized to approve this quote.", 403);
  }

  const quote = await Quote.findById(quoteId);
  if (!quote || quote.repair.toString() !== repair.id.toString()) {
    throw new AppError("Quote not found for this repair.", 404);
  }

  if (quote.status === QUOTE_STATUS.ACCEPTED) {
    return quote;
  }

  quote.status = QUOTE_STATUS.ACCEPTED;
  await quote.save();

  // Data integrity check: log if other quotes are still SENT/VIEWED
  const lingeringQuotes = await Quote.find({
    repair: repairId,
    _id: { $ne: quoteId },
    status: { $in: [QUOTE_STATUS.SENT, QUOTE_STATUS.VIEWED] }
  });

  if (lingeringQuotes.length > 0) {
    console.error(`DATA INTEGRITY BUG: Repair ${repairId} has lingering SENT/VIEWED quotes after approval.`);
  }

  return quote;
};

export const transitionToInRepair = async (repairId) => {
  const repair = await Repair.findById(repairId);
  if (!repair) {
    throw new AppError("Repair not found.", 404);
  }

  // HARD BLOCK: A repair cannot move to IN_REPAIR unless it has at least one quote with status ACCEPTED.
  const acceptedQuote = await Quote.findOne({ repair: repairId, status: QUOTE_STATUS.ACCEPTED });
  if (!acceptedQuote) {
    throw new AppError("Cannot start repair without an accepted quote.", 400);
  }

  repair.status = REPAIR_STATUS.IN_REPAIR;
  await repair.save();
  return repair;
};
